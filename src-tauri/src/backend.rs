//! Headless protocol server for `comparecraft-backend`, used by the VS Code extension.
//!
//! JSON-RPC 2.0 over stdin/stdout with `Content-Length` framing. The contract (limits, error codes,
//! lifecycle) is documented in `docs/vscode-extension/backend-protocol.md`; keep the two in sync.
//! Every method is read-only: the helper never writes, deletes or executes anything.

use crate::{diff, fileio, merge};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{self, BufRead, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

pub const PROTOCOL_VERSION: u64 = 1;
pub const SERVER_NAME: &str = "comparecraft-backend";
pub const MAX_MESSAGE_BYTES: usize = 64 << 20;
pub const MAX_HEADER_BYTES: usize = 8 << 10;
pub const MAX_CONCURRENT: usize = 4;
pub const MAX_QUEUED: usize = 64;
pub const MAX_LINES_PER_SIDE: usize = 2_000_000;
pub const METHODS: [&str; 4] = ["path.info", "text.load", "text.diff", "text.merge"];

pub mod code {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL: i64 = -32603;
    pub const NOT_INITIALIZED: i64 = -32002;
    pub const CANCELLED: i64 = -32800;
    pub const UNSUPPORTED_PROTOCOL: i64 = -32010;
    pub const IO: i64 = -32020;
    pub const LIMIT: i64 = -32021;
    pub const BUSY: i64 = -32022;
}

#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    fn new(code: i64, message: impl Into<String>) -> Self {
        RpcError { code, message: message.into(), data: None }
    }

    fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    fn to_json(&self) -> Value {
        let mut e = json!({ "code": self.code, "message": self.message });
        if let Some(d) = &self.data {
            e["data"] = d.clone();
        }
        e
    }
}

/// Diagnostics on stderr; stdout is reserved for protocol frames.
#[derive(Clone, Copy, Debug, Default)]
pub struct Logger {
    pub debug: bool,
}

impl Logger {
    pub fn from_env() -> Self {
        Logger { debug: std::env::var("COMPARECRAFT_BACKEND_LOG").is_ok_and(|v| v.eq_ignore_ascii_case("debug")) }
    }

    pub fn debug(&self, message: impl AsRef<str>) {
        if self.debug {
            eprintln!("{SERVER_NAME}: debug: {}", message.as_ref());
        }
    }

    pub fn warn(&self, message: impl AsRef<str>) {
        eprintln!("{SERVER_NAME}: warning: {}", message.as_ref());
    }

    pub fn error(&self, message: impl AsRef<str>) {
        eprintln!("{SERVER_NAME}: error: {}", message.as_ref());
    }
}

#[derive(Debug, PartialEq)]
pub enum Frame {
    Message(Vec<u8>),
    /// A body above `MAX_MESSAGE_BYTES`; it was read and discarded so the stream stays in sync.
    TooLarge(usize),
    Eof,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

/// Reads one `Content-Length` framed message. Errors mean the stream is no longer trustworthy.
pub fn read_frame<R: BufRead>(input: &mut R) -> io::Result<Frame> {
    let mut header_bytes = 0usize;
    let mut length: Option<usize> = None;
    let mut first = true;
    loop {
        let mut line = Vec::new();
        let n = input.by_ref().take((MAX_HEADER_BYTES + 1 - header_bytes) as u64).read_until(b'\n', &mut line)?;
        if n == 0 {
            return if first { Ok(Frame::Eof) } else { Err(io::Error::new(io::ErrorKind::UnexpectedEof, "end of input inside a frame header")) };
        }
        first = false;
        header_bytes += n;
        if header_bytes > MAX_HEADER_BYTES || !line.ends_with(b"\n") {
            return Err(invalid("frame header is too large or truncated"));
        }
        let text = std::str::from_utf8(&line).map_err(|_| invalid("frame header is not UTF-8"))?;
        let text = text.trim_end_matches(['\r', '\n']);
        if text.is_empty() {
            break;
        }
        let (name, value) = text.split_once(':').ok_or_else(|| invalid(format!("malformed header line: {text}")))?;
        if name.trim().eq_ignore_ascii_case("content-length") {
            let parsed = value.trim().parse::<usize>().map_err(|_| invalid(format!("invalid Content-Length: {}", value.trim())))?;
            length = Some(parsed);
        }
    }
    let length = length.ok_or_else(|| invalid("missing Content-Length header"))?;
    if length > MAX_MESSAGE_BYTES {
        let skipped = io::copy(&mut input.by_ref().take(length as u64), &mut io::sink())?;
        if skipped != length as u64 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "end of input inside an oversized frame"));
        }
        return Ok(Frame::TooLarge(length));
    }
    let mut body = vec![0u8; length];
    input.read_exact(&mut body)?;
    Ok(Frame::Message(body))
}

pub fn write_frame<W: Write + ?Sized>(output: &mut W, body: &[u8]) -> io::Result<()> {
    write!(output, "Content-Length: {}\r\n\r\n", body.len())?;
    output.write_all(body)?;
    output.flush()
}

// ---------------------------------------------------------------------------------------------------
// Methods

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PathParams {
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiffParams {
    left: Vec<String>,
    right: Vec<String>,
    #[serde(default)]
    rules: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MergeParams {
    base: Vec<String>,
    left: Vec<String>,
    right: Vec<String>,
    #[serde(default)]
    rules: Option<Value>,
}

fn params<T: DeserializeOwned>(value: Value) -> Result<T, RpcError> {
    let value = if value.is_null() { Value::Object(Map::new()) } else { value };
    serde_json::from_value(value).map_err(|e| RpcError::new(code::INVALID_PARAMS, format!("invalid params: {e}")))
}

fn absolute(path: &str) -> Result<(), RpcError> {
    if path.is_empty() || !Path::new(path).is_absolute() {
        return Err(RpcError::new(code::INVALID_PARAMS, format!("path must be absolute: {path:?}")));
    }
    Ok(())
}

/// `Rules` ignores unknown fields for desktop compatibility; the protocol rejects them so typos are visible.
fn rules(value: Option<Value>) -> Result<diff::Rules, RpcError> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(diff::Rules::default());
    };
    let Value::Object(given) = &value else {
        return Err(RpcError::new(code::INVALID_PARAMS, "rules must be an object"));
    };
    let known = serde_json::to_value(diff::Rules::default()).unwrap_or_default();
    if let Some(unknown) = given.keys().find(|k| known.get(k.as_str()).is_none()) {
        return Err(RpcError::new(code::INVALID_PARAMS, format!("unknown rules field: {unknown}")));
    }
    serde_json::from_value(value).map_err(|e| RpcError::new(code::INVALID_PARAMS, format!("invalid rules: {e}")))
}

fn limit_lines(sides: &[&[String]]) -> Result<(), RpcError> {
    if let Some(actual) = sides.iter().map(|s| s.len()).find(|n| *n > MAX_LINES_PER_SIDE) {
        return Err(RpcError::new(code::LIMIT, format!("input has {actual} lines; the limit is {MAX_LINES_PER_SIDE}"))
            .with_data(json!({ "limit": MAX_LINES_PER_SIDE, "actual": actual })));
    }
    Ok(())
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value, RpcError> {
    serde_json::to_value(value).map_err(|e| RpcError::new(code::INTERNAL, format!("could not encode result: {e}")))
}

/// Runs one engine method. Public so the method layer can be tested without framing.
pub fn call(method: &str, value: Value) -> Result<Value, RpcError> {
    match method {
        "path.info" => {
            let p: PathParams = params(value)?;
            absolute(&p.path)?;
            to_value(fileio::path_info(&p.path))
        }
        "text.load" => {
            let p: PathParams = params(value)?;
            absolute(&p.path)?;
            let file = fileio::load_text(&p.path).map_err(|e| {
                RpcError::new(code::IO, format!("{}: {e}", p.path)).with_data(json!({ "path": p.path, "kind": format!("{:?}", e.kind()) }))
            })?;
            to_value(file)
        }
        "text.diff" => {
            let p: DiffParams = params(value)?;
            limit_lines(&[&p.left, &p.right])?;
            let r = rules(p.rules)?;
            to_value(diff::diff_lines(&p.left, &p.right, &r))
        }
        "text.merge" => {
            let p: MergeParams = params(value)?;
            limit_lines(&[&p.base, &p.left, &p.right])?;
            let r = rules(p.rules)?;
            to_value(merge::merge3(&p.base, &p.left, &p.right, &r))
        }
        #[cfg(test)]
        "test.sleep" => {
            std::thread::sleep(std::time::Duration::from_millis(value["ms"].as_u64().unwrap_or(0)));
            Ok(Value::Null)
        }
        _ => Err(RpcError::new(code::METHOD_NOT_FOUND, format!("unknown method: {method}"))),
    }
}

fn dispatchable(method: &str) -> bool {
    METHODS.contains(&method) || (cfg!(test) && method == "test.sleep")
}

// ---------------------------------------------------------------------------------------------------
// Server

struct Job {
    key: String,
    id: Value,
    method: String,
    params: Value,
}

#[derive(Default)]
struct State {
    queue: VecDeque<Job>,
    /// Requests that are queued or running and still owe a response, by id key.
    pending: HashMap<String, Value>,
    closing: bool,
}

struct Shared {
    output: Mutex<Box<dyn Write + Send>>,
    state: Mutex<State>,
    ready: Condvar,
    log: Logger,
}

impl Shared {
    fn send(&self, message: &Value) {
        let mut body = message.to_string().into_bytes();
        if body.len() > MAX_MESSAGE_BYTES {
            let id = message.get("id").cloned().unwrap_or(Value::Null);
            let e = RpcError::new(code::LIMIT, format!("response of {} bytes exceeds maxMessageBytes", body.len()))
                .with_data(json!({ "limit": MAX_MESSAGE_BYTES, "actual": body.len() }));
            self.log.warn(&e.message);
            body = json!({ "jsonrpc": "2.0", "id": id, "error": e.to_json() }).to_string().into_bytes();
        }
        let mut out = self.output.lock().unwrap_or_else(|p| p.into_inner());
        if let Err(e) = write_frame(&mut **out, &body) {
            self.log.error(format!("could not write to stdout: {e}"));
        }
    }

    fn reply(&self, id: &Value, result: Result<Value, RpcError>) {
        let message = match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e.to_json() }),
        };
        self.send(&message);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn worker(shared: Arc<Shared>) {
    loop {
        let job = {
            let mut state = shared.lock();
            loop {
                if let Some(job) = state.queue.pop_front() {
                    break job;
                }
                if state.closing {
                    return;
                }
                state = shared.ready.wait(state).unwrap_or_else(|p| p.into_inner());
            }
        };
        if !shared.lock().pending.contains_key(&job.key) {
            continue;
        }
        let started = Instant::now();
        let result = catch_unwind(AssertUnwindSafe(|| call(&job.method, job.params))).unwrap_or_else(|_| {
            shared.log.error(format!("{} (id {}) panicked", job.method, job.key));
            Err(RpcError::new(code::INTERNAL, format!("internal error while running {}", job.method)))
        });
        shared.log.debug(format!("{} id={} {:?} {}", job.method, job.key, started.elapsed(), if result.is_ok() { "ok" } else { "error" }));
        // A cancelled request was already answered; its late result is dropped.
        if shared.lock().pending.remove(&job.key).is_some() {
            shared.reply(&job.id, result);
        } else {
            shared.log.debug(format!("dropped result of cancelled request id={}", job.key));
        }
    }
}

fn id_key(id: &Value) -> String {
    id.to_string()
}

/// Serves the protocol until `exit`, end of input or a framing error, and returns the process exit code.
pub fn serve<R: BufRead>(mut input: R, output: Box<dyn Write + Send>, log: Logger) -> i32 {
    let shared = Arc::new(Shared { output: Mutex::new(output), state: Mutex::new(State::default()), ready: Condvar::new(), log });
    let workers = std::thread::available_parallelism().map_or(1, |n| n.get()).clamp(1, MAX_CONCURRENT);
    for _ in 0..workers {
        let s = Arc::clone(&shared);
        std::thread::spawn(move || worker(s));
    }
    let mut initialized = false;
    let mut shut_down = false;
    let code = loop {
        let body = match read_frame(&mut input) {
            Ok(Frame::Message(body)) => body,
            Ok(Frame::TooLarge(n)) => {
                log.warn(format!("discarded a {n}-byte message above maxMessageBytes"));
                let e = RpcError::new(code::INVALID_REQUEST, format!("message of {n} bytes exceeds maxMessageBytes"))
                    .with_data(json!({ "limit": MAX_MESSAGE_BYTES, "actual": n }));
                shared.reply(&Value::Null, Err(e));
                continue;
            }
            Ok(Frame::Eof) => break if shut_down { 0 } else { 1 },
            Err(e) => {
                log.error(format!("protocol stream error: {e}"));
                break 2;
            }
        };
        let message: Value = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => {
                shared.reply(&Value::Null, Err(RpcError::new(code::PARSE_ERROR, format!("invalid JSON: {e}"))));
                continue;
            }
        };
        let id = message.get("id").cloned();
        let bad = |why: &str| RpcError::new(code::INVALID_REQUEST, why.to_string());
        if !message.is_object() || message.get("jsonrpc") != Some(&json!("2.0")) {
            shared.reply(&Value::Null, Err(bad("expected a JSON-RPC 2.0 object")));
            continue;
        }
        let Some(method) = message.get("method").and_then(Value::as_str).map(str::to_string) else {
            if message.get("result").is_none() && message.get("error").is_none() {
                shared.reply(id.as_ref().unwrap_or(&Value::Null), Err(bad("missing method")));
            }
            continue;
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);

        let Some(id) = id else {
            match method.as_str() {
                "exit" => break if shut_down { 0 } else { 1 },
                "$/cancelRequest" if initialized => {
                    let Some(target) = params.get("id").filter(|v| v.is_number() || v.is_string()) else { continue };
                    let key = id_key(target);
                    let mut state = shared.lock();
                    if state.pending.remove(&key).is_some() {
                        state.queue.retain(|j| j.key != key);
                        drop(state);
                        log.debug(format!("cancelled id={key}"));
                        shared.reply(target, Err(RpcError::new(code::CANCELLED, "request cancelled")));
                    }
                }
                other => log.debug(format!("ignored notification {other}")),
            }
            continue;
        };
        if !(id.is_number() || id.is_string()) {
            shared.reply(&Value::Null, Err(bad("id must be a number or string")));
            continue;
        }
        if shut_down {
            shared.reply(&id, Err(bad("the server is shutting down")));
            continue;
        }
        match method.as_str() {
            "initialize" if initialized => shared.reply(&id, Err(bad("already initialized"))),
            "initialize" => {
                let offered: Vec<u64> = params
                    .get("protocolVersions")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_u64).collect())
                    .unwrap_or_default();
                if offered.contains(&PROTOCOL_VERSION) {
                    initialized = true;
                    let client = params.get("client").map(Value::to_string).unwrap_or_default();
                    log.debug(format!("initialized protocol {PROTOCOL_VERSION} for {client}"));
                    shared.reply(
                        &id,
                        Ok(json!({
                            "protocolVersion": PROTOCOL_VERSION,
                            "server": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
                            "capabilities": { "methods": METHODS },
                            "limits": {
                                "maxMessageBytes": MAX_MESSAGE_BYTES,
                                "maxConcurrentRequests": workers,
                                "maxQueuedRequests": MAX_QUEUED,
                                "maxLinesPerSide": MAX_LINES_PER_SIDE
                            }
                        })),
                    );
                } else {
                    let e = RpcError::new(code::UNSUPPORTED_PROTOCOL, format!("no common protocol version; this backend supports {PROTOCOL_VERSION}"))
                        .with_data(json!({ "supported": [PROTOCOL_VERSION] }));
                    shared.reply(&id, Err(e));
                }
            }
            _ if !initialized => shared.reply(&id, Err(RpcError::new(code::NOT_INITIALIZED, "initialize first"))),
            "shutdown" => {
                shut_down = true;
                shared.reply(&id, Ok(Value::Null));
            }
            m if dispatchable(m) => {
                let key = id_key(&id);
                let mut state = shared.lock();
                if state.pending.contains_key(&key) {
                    drop(state);
                    shared.reply(&id, Err(bad("duplicate request id")));
                } else if state.queue.len() >= MAX_QUEUED {
                    drop(state);
                    shared.reply(&id, Err(RpcError::new(code::BUSY, "too many queued requests")));
                } else {
                    state.pending.insert(key.clone(), id.clone());
                    state.queue.push_back(Job { key, id, method, params });
                    drop(state);
                    shared.ready.notify_one();
                }
            }
            m => shared.reply(&id, Err(RpcError::new(code::METHOD_NOT_FOUND, format!("unknown method: {m}")))),
        }
    };
    let mut state = shared.lock();
    state.closing = true;
    state.queue.clear();
    drop(state);
    shared.ready.notify_all();
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn frame(v: Value) -> Vec<u8> {
        let mut out = Vec::new();
        write_frame(&mut out, v.to_string().as_bytes()).unwrap();
        out
    }

    fn run(messages: &[Value]) -> (i32, Vec<Value>) {
        let input: Vec<u8> = messages.iter().flat_map(|m| frame(m.clone())).collect();
        run_raw(input)
    }

    fn run_raw(input: Vec<u8>) -> (i32, Vec<Value>) {
        let sink = Sink::default();
        let code = serve(Cursor::new(input), Box::new(sink.clone()), Logger::default());
        let bytes = sink.0.lock().unwrap().clone();
        let mut cursor = Cursor::new(bytes);
        let mut out = Vec::new();
        while let Frame::Message(body) = read_frame(&mut cursor).unwrap() {
            out.push(serde_json::from_slice(&body).unwrap());
        }
        (code, out)
    }

    fn init() -> Value {
        json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersions": [1], "client": { "name": "test" } } })
    }

    fn req(id: i64, method: &str, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    fn by_id(out: &[Value], id: i64) -> &Value {
        out.iter().find(|m| m["id"] == json!(id)).unwrap_or_else(|| panic!("no response {id}: {out:?}"))
    }

    // Responses to queued work arrive asynchronously; keep stdin open until they are written.
    fn run_waiting(messages: &[Value], expected: usize) -> (i32, Vec<Value>) {
        let (reader, mut writer) = pipe();
        let sink = Sink::default();
        let s2 = sink.clone();
        let handle = std::thread::spawn(move || serve(io::BufReader::new(reader), Box::new(s2), Logger::default()));
        for m in messages {
            writer.write_all(&frame(m.clone())).unwrap();
        }
        let deadline = Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let count = parse_all(&sink.0.lock().unwrap()).len();
            if count >= expected || Instant::now() > deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        writer.write_all(&frame(json!({ "jsonrpc": "2.0", "id": 999, "method": "shutdown" }))).unwrap();
        writer.write_all(&frame(json!({ "jsonrpc": "2.0", "method": "exit" }))).unwrap();
        drop(writer);
        let code = handle.join().unwrap();
        let out = parse_all(&sink.0.lock().unwrap());
        (code, out)
    }

    fn parse_all(bytes: &[u8]) -> Vec<Value> {
        let mut cursor = Cursor::new(bytes.to_vec());
        let mut out = Vec::new();
        while let Ok(Frame::Message(body)) = read_frame(&mut cursor) {
            out.push(serde_json::from_slice(&body).unwrap());
        }
        out
    }

    /// A minimal in-memory pipe: the reader blocks until data arrives or the writer is dropped.
    fn pipe() -> (PipeReader, PipeWriter) {
        let shared = Arc::new((Mutex::new((VecDeque::new(), false)), Condvar::new()));
        (PipeReader(Arc::clone(&shared)), PipeWriter(shared))
    }

    type PipeState = Arc<(Mutex<(VecDeque<u8>, bool)>, Condvar)>;
    struct PipeReader(PipeState);
    struct PipeWriter(PipeState);

    impl Read for PipeReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let (lock, cv) = &*self.0;
            let mut g = lock.lock().unwrap();
            while g.0.is_empty() && !g.1 {
                g = cv.wait(g).unwrap();
            }
            let n = buf.len().min(g.0.len());
            for (i, b) in g.0.drain(..n).enumerate() {
                buf[i] = b;
            }
            Ok(n)
        }
    }

    impl Write for PipeWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let (lock, cv) = &*self.0;
            lock.lock().unwrap().0.extend(buf);
            cv.notify_all();
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Drop for PipeWriter {
        fn drop(&mut self) {
            let (lock, cv) = &*self.0;
            lock.lock().unwrap().1 = true;
            cv.notify_all();
        }
    }

    #[test]
    fn frames_round_trip_and_reject_bad_headers() {
        let mut c = Cursor::new(b"Content-Type: x\r\ncontent-length: 2\r\n\r\n{}".to_vec());
        assert_eq!(read_frame(&mut c).unwrap(), Frame::Message(b"{}".to_vec()));
        assert_eq!(read_frame(&mut c).unwrap(), Frame::Eof);
        assert!(read_frame(&mut Cursor::new(b"X: 1\r\n\r\n{}".to_vec())).is_err());
        assert!(read_frame(&mut Cursor::new(b"Content-Length: abc\r\n\r\n".to_vec())).is_err());
        assert!(read_frame(&mut Cursor::new(b"Content-Length: 5\r\n\r\n{}".to_vec())).is_err());
        let huge = format!("X-Pad: {}\r\n", "a".repeat(MAX_HEADER_BYTES));
        assert!(read_frame(&mut Cursor::new(huge.into_bytes())).is_err());
    }

    #[test]
    fn oversized_bodies_are_skipped_without_losing_sync() {
        let n = MAX_MESSAGE_BYTES + 1;
        let mut input = format!("Content-Length: {n}\r\n\r\n").into_bytes();
        input.resize(input.len() + n, b' ');
        input.extend(frame(init()));
        let mut c = Cursor::new(input.clone());
        assert_eq!(read_frame(&mut c).unwrap(), Frame::TooLarge(n));
        assert!(matches!(read_frame(&mut c).unwrap(), Frame::Message(_)));
        let (code, out) = run_raw(input);
        assert_eq!(code, 1);
        assert_eq!(out[0]["error"]["code"], json!(code::INVALID_REQUEST));
        assert_eq!(out[0]["id"], Value::Null);
        assert_eq!(out[1]["result"]["protocolVersion"], json!(1));
    }

    #[test]
    fn handshake_negotiates_and_gates_requests() {
        let (code, out) = run(&[
            req(1, "text.diff", json!({ "left": [], "right": [] })),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": { "protocolVersions": [7, 8] } }),
            init(),
            init(),
            req(3, "nope", json!({})),
            req(4, "shutdown", Value::Null),
            req(5, "path.info", json!({ "path": "/" })),
            json!({ "jsonrpc": "2.0", "method": "exit" }),
        ]);
        assert_eq!(code, 0);
        assert_eq!(by_id(&out, 1)["error"]["code"], json!(code::NOT_INITIALIZED));
        assert_eq!(by_id(&out, 2)["error"]["code"], json!(code::UNSUPPORTED_PROTOCOL));
        assert_eq!(by_id(&out, 2)["error"]["data"]["supported"], json!([1]));
        let inits: Vec<&Value> = out.iter().filter(|m| m["id"] == json!(0)).collect();
        assert_eq!(inits[0]["result"]["server"]["name"], json!(SERVER_NAME));
        assert_eq!(inits[0]["result"]["capabilities"]["methods"], json!(METHODS));
        assert_eq!(inits[1]["error"]["code"], json!(code::INVALID_REQUEST));
        assert_eq!(by_id(&out, 3)["error"]["code"], json!(code::METHOD_NOT_FOUND));
        assert_eq!(by_id(&out, 4)["result"], Value::Null);
        assert_eq!(by_id(&out, 5)["error"]["code"], json!(code::INVALID_REQUEST));
    }

    #[test]
    fn exit_without_shutdown_and_eof_report_failure() {
        assert_eq!(run(&[init(), json!({ "jsonrpc": "2.0", "method": "exit" })]).0, 1);
        assert_eq!(run(&[init()]).0, 1);
        assert_eq!(run_raw(b"Content-Length: 9\r\n\r\n{".to_vec()).0, 2);
    }

    #[test]
    fn malformed_messages_get_errors_and_the_server_continues() {
        let mut input = Vec::new();
        write_frame(&mut input, b"not json").unwrap();
        input.extend(frame(json!([1, 2])));
        input.extend(frame(json!({ "jsonrpc": "2.0", "id": [1], "method": "initialize" })));
        input.extend(frame(json!({ "jsonrpc": "2.0", "id": 1, "result": 5 })));
        input.extend(frame(init()));
        let (_, out) = run_raw(input);
        assert_eq!(out[0]["error"]["code"], json!(code::PARSE_ERROR));
        assert_eq!(out[1]["error"]["code"], json!(code::INVALID_REQUEST));
        assert_eq!(out[2]["error"]["code"], json!(code::INVALID_REQUEST));
        assert_eq!(out[3]["result"]["protocolVersion"], json!(1));
        assert_eq!(out.len(), 4);
    }

    #[test]
    fn engine_methods_match_the_desktop_engine() {
        let left = vec!["a".to_string(), "b".to_string()];
        let right = vec!["a".to_string(), "c".to_string()];
        let strict = json!({ "ignoreCase": false, "ignoreLeadingWs": false, "ignoreTrailingWs": false, "ignoreEmbeddedWs": false, "ignoreBlankLines": false });
        let got = call("text.diff", json!({ "left": left, "right": right, "rules": strict.clone() })).unwrap();
        let rules: diff::Rules = serde_json::from_value(strict).unwrap();
        assert_eq!(got, serde_json::to_value(diff::diff_lines(&left, &right, &rules)).unwrap());
        assert_eq!(got["identical"], json!(false));

        let merged = call("text.merge", json!({ "base": ["x"], "left": ["x", "l"], "right": ["r", "x"] })).unwrap();
        assert_eq!(merged["conflicts"], json!(0));

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f.txt");
        std::fs::write(&file, "\u{feff}one\r\ntwo\r\n").unwrap();
        let path = file.to_string_lossy().to_string();
        let loaded = call("text.load", json!({ "path": path })).unwrap();
        assert_eq!(loaded["lines"], json!(["one", "two"]));
        assert_eq!(loaded["bom"], json!(true));
        assert_eq!(loaded["eol"], json!("CRLF"));
        assert_eq!(call("path.info", json!({ "path": path })).unwrap()["exists"], json!(true));
    }

    #[test]
    fn invalid_params_are_explicit() {
        let err = |m: &str, p: Value| call(m, p).unwrap_err().code;
        assert_eq!(err("text.diff", json!({ "left": [] })), code::INVALID_PARAMS);
        assert_eq!(err("text.diff", json!({ "left": [], "right": [], "extra": 1 })), code::INVALID_PARAMS);
        assert_eq!(err("text.diff", json!({ "left": [], "right": [], "rules": { "ignoreCas": true } })), code::INVALID_PARAMS);
        assert_eq!(err("text.diff", json!({ "left": [], "right": [], "rules": 3 })), code::INVALID_PARAMS);
        assert_eq!(err("text.load", json!({ "path": "relative.txt" })), code::INVALID_PARAMS);
        assert_eq!(err("path.info", Value::Null), code::INVALID_PARAMS);
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.txt").to_string_lossy().to_string();
        let e = call("text.load", json!({ "path": missing })).unwrap_err();
        assert_eq!(e.code, code::IO);
        assert_eq!(e.data.unwrap()["kind"], json!("NotFound"));
        let big = vec![String::new(); MAX_LINES_PER_SIDE + 1];
        let e = call("text.diff", json!({ "left": big, "right": [] })).unwrap_err();
        assert_eq!(e.code, code::LIMIT);
    }

    #[test]
    fn many_requests_each_get_exactly_one_response() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let mut messages = vec![init()];
        for id in 1..=10 {
            messages.push(req(id, "path.info", json!({ "path": path })));
        }
        let (code, out) = run_waiting(&messages, 11);
        assert_eq!(code, 0);
        for id in 1..=10 {
            assert_eq!(out.iter().filter(|m| m["id"] == json!(id)).count(), 1);
            assert_eq!(by_id(&out, id)["result"]["isDir"], json!(true));
        }
    }

    fn sleep(id: i64, ms: u64) -> Value {
        req(id, "test.sleep", json!({ "ms": ms }))
    }

    fn cancel(id: i64) -> Value {
        json!({ "jsonrpc": "2.0", "method": "$/cancelRequest", "params": { "id": id } })
    }

    #[test]
    fn cancellation_answers_once_and_drops_late_results() {
        // Request 2 outlives request 1, so a late result from the cancelled sleep would already be in the output.
        let (_, out) = run_waiting(&[init(), sleep(1, 200), sleep(2, 500), cancel(1), cancel(1), cancel(777)], 3);
        let first: Vec<&Value> = out.iter().filter(|m| m["id"] == json!(1)).collect();
        assert_eq!(first.len(), 1, "{first:?}");
        assert_eq!(first[0]["error"]["code"], json!(code::CANCELLED));
        assert_eq!(by_id(&out, 2)["result"], Value::Null);
        assert!(out.iter().all(|m| m["id"] != json!(777)));
    }

    #[test]
    fn a_full_queue_reports_busy() {
        let total = (MAX_CONCURRENT + MAX_QUEUED + 3) as i64;
        let mut messages = vec![init()];
        messages.extend((1..=total).map(|id| sleep(id, 200)));
        messages.extend((1..=total).map(cancel));
        let (_, out) = run_waiting(&messages, total as usize + 1);
        for id in 1..=total {
            assert_eq!(out.iter().filter(|m| m["id"] == json!(id)).count(), 1, "id {id}");
        }
        let busy = out.iter().filter(|m| m["error"]["code"] == json!(code::BUSY)).count();
        assert!(busy >= 3, "busy responses: {busy}");
    }

    #[test]
    fn duplicate_pending_ids_are_rejected() {
        let (_, out) = run_waiting(&[init(), sleep(50, 200), sleep(50, 0)], 3);
        let fifty: Vec<&Value> = out.iter().filter(|m| m["id"] == json!(50)).collect();
        assert_eq!(fifty.len(), 2);
        assert_eq!(fifty[0]["error"]["code"], json!(code::INVALID_REQUEST));
        assert_eq!(fifty[1]["result"], Value::Null);
    }
}
