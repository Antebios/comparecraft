//! Request validation and in-memory methods shared by the headless helper (`backend`) and the
//! WebAssembly engine (`wasm`), so both answer the same requests with the same results and errors.
//!
//! Path-based methods (folders, `text.load`, ...) stay in `backend`; this module only handles data the
//! caller passes in: line arrays for `text.diff`/`text.merge`, and file contents for the WebAssembly
//! engine's `*Data` methods. The contract is documented in `docs/vscode-extension/backend-protocol.md`.

use crate::{diff, fileio, hex, merge, pix, quick, table};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Map, Value};

pub const MAX_LINES_PER_SIDE: usize = 2_000_000;
/// Table files are parsed whole in memory; larger files get `LIMIT`.
pub const MAX_TABLE_FILE_BYTES: u64 = 64 << 20;
/// Picture files are decoded whole and returned as PNG data URLs; larger files get `LIMIT`.
pub const MAX_PICTURE_FILE_BYTES: u64 = 64 << 20;
/// Largest buffer the in-memory (`*Data`, `text.decode`) methods accept per side.
pub const MAX_DATA_BYTES: u64 = 64 << 20;

/// Methods of the in-memory engine (`call_memory`).
pub const MEMORY_METHODS: [&str; 10] = [
    "engine.info",
    "text.diff",
    "text.merge",
    "text.decode",
    "kind.detect",
    "hex.alignData",
    "table.compareData",
    "pix.compareData",
    "pix.imageData",
    "quick.compareData",
];

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
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        RpcError { code, message: message.into(), data: None }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn to_json(&self) -> Value {
        let mut e = json!({ "code": self.code, "message": self.message });
        if let Some(d) = &self.data {
            e["data"] = d.clone();
        }
        e
    }
}

pub fn params<T: DeserializeOwned>(value: Value) -> Result<T, RpcError> {
    let value = if value.is_null() { Value::Object(Map::new()) } else { value };
    serde_json::from_value(value).map_err(|e| RpcError::new(code::INVALID_PARAMS, format!("invalid params: {e}")))
}

/// `Rules` ignores unknown fields for desktop compatibility; the protocol rejects them so typos are visible.
pub fn rules(value: Option<Value>) -> Result<diff::Rules, RpcError> {
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

pub fn limit_lines(sides: &[&[String]]) -> Result<(), RpcError> {
    if let Some(actual) = sides.iter().map(|s| s.len()).find(|n| *n > MAX_LINES_PER_SIDE) {
        return Err(RpcError::new(code::LIMIT, format!("input has {actual} lines; the limit is {MAX_LINES_PER_SIDE}"))
            .with_data(json!({ "limit": MAX_LINES_PER_SIDE, "actual": actual })));
    }
    Ok(())
}

/// Rejects an in-memory input above `limit` bytes; `name` identifies it in the message.
pub fn limit_bytes(name: &str, actual: usize, limit: u64) -> Result<(), RpcError> {
    if actual as u64 > limit {
        return Err(RpcError::new(code::LIMIT, format!("{name} is {actual} bytes; the limit is {limit}"))
            .with_data(json!({ "limit": limit, "actual": actual })));
    }
    Ok(())
}

pub fn to_value<T: serde::Serialize>(value: T) -> Result<Value, RpcError> {
    serde_json::to_value(value).map_err(|e| RpcError::new(code::INTERNAL, format!("could not encode result: {e}")))
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

/// `text.diff`: `{ left, right, rules? }` → `DiffResult`.
pub fn text_diff(value: Value) -> Result<Value, RpcError> {
    let p: DiffParams = params(value)?;
    limit_lines(&[&p.left, &p.right])?;
    let r = rules(p.rules)?;
    to_value(diff::diff_lines(&p.left, &p.right, &r))
}

/// `text.merge`: `{ base, left, right, rules? }` → `MergeResult`.
pub fn text_merge(value: Value) -> Result<Value, RpcError> {
    let p: MergeParams = params(value)?;
    limit_lines(&[&p.base, &p.left, &p.right])?;
    let r = rules(p.rules)?;
    to_value(merge::merge3(&p.base, &p.left, &p.right, &r))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NameParams {
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HexDataParams {
    #[serde(default)]
    align: hex::HexAlign,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QuickDataParams {
    mode: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TableDataParams {
    left_name: String,
    right_name: String,
    #[serde(default)]
    options: table::TableOptions,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PixDataParams {
    left_name: String,
    right_name: String,
    #[serde(default)]
    options: pix::PixOptions,
    #[serde(default)]
    left_data: Option<String>,
    #[serde(default)]
    right_data: Option<String>,
}

/// Runs one in-memory method. `a` and `b` are the file contents of the first and second input for the
/// methods that take them (`text.decode`, `kind.detect`, `*Data`); other methods ignore them.
pub fn call_memory(method: &str, value: Value, a: &[u8], b: &[u8]) -> Result<Value, RpcError> {
    match method {
        "engine.info" => Ok(json!({
            "version": crate::APP_VERSION,
            "methods": MEMORY_METHODS,
            "limits": { "maxLinesPerSide": MAX_LINES_PER_SIDE, "maxDataBytes": MAX_DATA_BYTES }
        })),
        "text.diff" => text_diff(value),
        "text.merge" => text_merge(value),
        "text.decode" => {
            let p: NameParams = params(value)?;
            limit_bytes(&p.name, a.len(), MAX_DATA_BYTES)?;
            to_value(fileio::text_from_bytes(&p.name, a))
        }
        "kind.detect" => {
            let p: NameParams = params(value)?;
            to_value(fileio::kind_of(&p.name, a))
        }
        "hex.alignData" => {
            let p: HexDataParams = params(value)?;
            limit_bytes("left input", a.len(), MAX_DATA_BYTES)?;
            limit_bytes("right input", b.len(), MAX_DATA_BYTES)?;
            to_value(hex::align_data(a, b, p.align))
        }
        "table.compareData" => {
            let p: TableDataParams = params(value)?;
            limit_bytes(&p.left_name, a.len(), MAX_TABLE_FILE_BYTES)?;
            limit_bytes(&p.right_name, b.len(), MAX_TABLE_FILE_BYTES)?;
            to_value(table::compare_table_data(&p.left_name, a, &p.right_name, b, &p.options))
        }
        "pix.compareData" => {
            let p: PixDataParams = params(value)?;
            limit_bytes(&p.left_name, a.len(), MAX_PICTURE_FILE_BYTES)?;
            limit_bytes(&p.right_name, b.len(), MAX_PICTURE_FILE_BYTES)?;
            let left = pix::PictureInput { name: &p.left_name, bytes: a, data: p.left_data.as_deref() };
            let right = pix::PictureInput { name: &p.right_name, bytes: b, data: p.right_data.as_deref() };
            to_value(pix::pix_compare_data(left, right, &p.options).map_err(|e| RpcError::new(code::IO, e))?)
        }
        "pix.imageData" => {
            let p: NameParams = params(value)?;
            limit_bytes(&p.name, a.len(), MAX_PICTURE_FILE_BYTES)?;
            to_value(pix::pix_image_data(&p.name, a).map_err(|e| RpcError::new(code::IO, format!("{}: {e}", p.name)))?)
        }
        "quick.compareData" => {
            let p: QuickDataParams = params(value)?;
            let mode = match p.mode.as_str() {
                "rules" => quick::QcMode::Rules,
                "size" => quick::QcMode::Size,
                "crc" => quick::QcMode::Crc,
                "binary" => quick::QcMode::Binary,
                _ => return Err(RpcError::new(code::INVALID_PARAMS, format!("invalid quick comparison mode: {}", p.mode))),
            };
            limit_bytes("left input", a.len(), MAX_DATA_BYTES)?;
            limit_bytes("right input", b.len(), MAX_DATA_BYTES)?;
            to_value(quick::quick_compare_data(a, b, mode))
        }
        _ => Err(RpcError::new(code::METHOD_NOT_FOUND, format!("unknown method: {method}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(method: &str, value: Value, a: &[u8], b: &[u8]) -> Result<Value, RpcError> {
        call_memory(method, value, a, b)
    }

    #[test]
    fn text_methods_validate_like_the_helper() {
        let got = call("text.diff", json!({ "left": ["a", "b"], "right": ["a", "c"] }), &[], &[]).unwrap();
        assert_eq!(got["identical"], json!(false));
        assert_eq!(call("text.diff", json!({ "left": [] }), &[], &[]).unwrap_err().code, code::INVALID_PARAMS);
        assert_eq!(call("text.diff", json!({ "left": [], "right": [], "rules": { "ignoreCas": true } }), &[], &[]).unwrap_err().code, code::INVALID_PARAMS);
        let merged = call("text.merge", json!({ "base": ["x"], "left": ["x", "l"], "right": ["r", "x"] }), &[], &[]).unwrap();
        assert_eq!(merged["conflicts"], json!(0));
        assert_eq!(call("folder.compare", json!({}), &[], &[]).unwrap_err().code, code::METHOD_NOT_FOUND);
    }

    #[test]
    fn decode_and_kind_match_the_file_loaders() {
        let bytes = b"\xEF\xBB\xBFone\r\ntwo\r\n";
        let got = call("text.decode", json!({ "name": "a.txt" }), bytes, &[]).unwrap();
        assert_eq!(got["lines"], json!(["one", "two"]));
        assert_eq!(got["encoding"], json!("UTF-8"));
        assert_eq!(got["bom"], json!(true));
        assert_eq!(got["eol"], json!("CRLF"));
        assert_eq!(got["finalNewline"], json!(true));
        assert_eq!(got["size"], json!(bytes.len()));
        assert_eq!(got["modified"], Value::Null);
        assert_eq!(call("kind.detect", json!({ "name": "x.CSV" }), b"a,b", &[]).unwrap(), json!("table"));
        assert_eq!(call("kind.detect", json!({ "name": "x.png" }), &[], &[]).unwrap(), json!("picture"));
        assert_eq!(call("kind.detect", json!({ "name": "x.bin" }), b"ab\0cd", &[]).unwrap(), json!("hex"));
        assert_eq!(call("kind.detect", json!({ "name": "x" }), b"plain", &[]).unwrap(), json!("text"));
    }

    #[test]
    fn data_methods_compare_in_memory_inputs() {
        let got = call("hex.alignData", json!({ "align": "none" }), &[1, 2, 3], &[1, 9, 3, 4]).unwrap();
        assert_eq!(got["leftSize"], json!(3));
        assert_eq!(got["rightSize"], json!(4));
        let got = call("table.compareData", json!({ "leftName": "a.csv", "rightName": "b.csv" }), b"1,x\n2,y\n", b"1,x\n2,z\n").unwrap();
        assert_eq!(got["rows"][1]["k"], json!("changed"));
        let png = pix::encode_png(1, 1, &[255, 0, 0, 255]).unwrap();
        let got = call("pix.compareData", json!({ "leftName": "a.png", "rightName": "b.png" }), &png, &png).unwrap();
        assert_eq!(got["counts"]["important"], json!(0));
        assert_eq!(call("quick.compareData", json!({ "mode": "rules" }), b"a\r\nb\r\n", b"a\nb\n").unwrap(), json!(2));
        assert_eq!(call("quick.compareData", json!({ "mode": "binary" }), b"a", b"b").unwrap(), json!(11));
        assert_eq!(call("quick.compareData", json!({ "mode": "nope" }), b"a", b"b").unwrap_err().code, code::INVALID_PARAMS);
        let url = call("pix.imageData", json!({ "name": "a.png" }), &png, &[]).unwrap();
        assert!(url.as_str().unwrap().starts_with("data:image/png;base64,"));
        let e = call("pix.imageData", json!({ "name": "broken.png" }), b"nope", &[]).unwrap_err();
        assert_eq!(e.code, code::IO);
        assert!(e.message.starts_with("broken.png: "), "{}", e.message);
    }

    #[test]
    fn data_methods_enforce_limits_and_fields() {
        let big = vec![0u8; MAX_DATA_BYTES as usize + 1];
        let e = call("text.decode", json!({ "name": "big.txt" }), &big, &[]).unwrap_err();
        assert_eq!(e.code, code::LIMIT);
        assert_eq!(e.data.unwrap()["limit"], json!(MAX_DATA_BYTES));
        assert_eq!(call("hex.alignData", json!({ "align": "bogus" }), &[], &[]).unwrap_err().code, code::INVALID_PARAMS);
        assert_eq!(call("text.decode", json!({ "name": "a", "extra": 1 }), &[], &[]).unwrap_err().code, code::INVALID_PARAMS);
        let info = call("engine.info", Value::Null, &[], &[]).unwrap();
        assert_eq!(info["methods"].as_array().unwrap().len(), MEMORY_METHODS.len());
    }
}
