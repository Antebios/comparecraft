//! The headless helper (`comparecraft-backend`) over real stdio pipes.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};

fn backend() -> Command {
    Command::new(env!("CARGO_BIN_EXE_comparecraft-backend"))
}

fn frame(message: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(message).unwrap();
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend(body);
    out
}

fn read_message(reader: &mut impl BufRead) -> Value {
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        assert!(reader.read_line(&mut line).unwrap() > 0, "unexpected end of output");
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(v) = line.strip_prefix("Content-Length:") {
            length = v.trim().parse().unwrap();
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}

#[test]
fn version_and_usage() {
    let out = backend().arg("--version").output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.starts_with("comparecraft-backend ") && text.contains("(protocol 1)"), "{text}");

    let out = backend().output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage: comparecraft-backend"));
}

#[test]
fn stdio_session_handshake_diff_and_clean_exit() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "one\r\ntwo\r\n").unwrap();

    let mut child = backend().arg("--stdio").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());

    stdin.write_all(&frame(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersions": [1], "client": { "name": "test", "version": "0" } } }))).unwrap();
    let init = read_message(&mut stdout);
    assert_eq!(init["result"]["protocolVersion"], json!(1));
    assert_eq!(init["result"]["server"]["name"], json!("comparecraft-backend"));
    assert!(init["result"]["capabilities"]["methods"].as_array().unwrap().contains(&json!("text.diff")));

    stdin.write_all(&frame(&json!({ "jsonrpc": "2.0", "id": 2, "method": "text.load", "params": { "path": file.to_string_lossy() } }))).unwrap();
    let loaded = read_message(&mut stdout);
    assert_eq!(loaded["result"]["lines"], json!(["one", "two"]));
    assert_eq!(loaded["result"]["eol"], json!("CRLF"));

    stdin.write_all(&frame(&json!({ "jsonrpc": "2.0", "id": 3, "method": "text.diff", "params": { "left": ["a", "b"], "right": ["a", "c"] } }))).unwrap();
    let diff = read_message(&mut stdout);
    assert_eq!(diff["id"], json!(3));
    assert_eq!(diff["result"]["identical"], json!(false));

    stdin.write_all(&frame(&json!({ "jsonrpc": "2.0", "id": 4, "method": "shutdown" }))).unwrap();
    assert_eq!(read_message(&mut stdout)["result"], Value::Null);
    stdin.write_all(&frame(&json!({ "jsonrpc": "2.0", "method": "exit" }))).unwrap();
    drop(stdin);
    assert_eq!(child.wait().unwrap().code(), Some(0));

    let mut rest = Vec::new();
    stdout.read_to_end(&mut rest).unwrap();
    assert!(rest.is_empty(), "stdout must carry only protocol frames");
}

#[test]
fn closing_stdin_without_shutdown_is_a_failure_exit() {
    let mut child = backend().arg("--stdio").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    drop(child.stdin.take());
    assert_eq!(child.wait().unwrap().code(), Some(1));
}
