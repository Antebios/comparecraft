//! Exported functions of the WebAssembly engine, used by the VS Code extension where the native helper
//! can't run (browser VS Code, virtual workspaces) and documented in
//! `docs/vscode-extension/backend-protocol.md` ("WebAssembly engine").
//!
//! The host copies a UTF-8 JSON request `{ "method": ..., "params": ... }` and up to two input buffers
//! (file contents) into memory from `cc_alloc`, then calls `cc_call`. The returned buffer holds a 4-byte
//! little-endian length followed by `{ "result": ... }` or `{ "error": { "code", "message", "data"? } }`.
//! The host releases every buffer, including the response (length + 4 bytes), with `cc_free`.

use crate::protocol::{self, code, RpcError};
use serde_json::{json, Value};

fn leak(buffer: Box<[u8]>) -> *mut u8 {
    Box::into_raw(buffer) as *mut u8
}

/// Allocates `len` zeroed bytes for the host to fill.
#[no_mangle]
pub extern "C" fn cc_alloc(len: usize) -> *mut u8 {
    leak(vec![0u8; len].into_boxed_slice())
}

/// Releases a buffer from `cc_alloc` or `cc_call`.
///
/// # Safety
/// `ptr` and `len` must describe a buffer returned by this module that has not been freed yet.
#[no_mangle]
pub unsafe extern "C" fn cc_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}

unsafe fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

/// Runs one request; see the module documentation for the buffer layout.
///
/// # Safety
/// Each pointer/length pair must describe readable memory owned by the caller (null with length 0 for
/// an absent input).
#[no_mangle]
pub unsafe extern "C" fn cc_call(request: *const u8, request_len: usize, a: *const u8, a_len: usize, b: *const u8, b_len: usize) -> *mut u8 {
    let result = match serde_json::from_slice::<Value>(input(request, request_len)) {
        Ok(request) => match request.get("method").and_then(Value::as_str) {
            Some(method) => {
                let params = request.get("params").cloned().unwrap_or(Value::Null);
                protocol::call_memory(method, params, input(a, a_len), input(b, b_len))
            }
            None => Err(RpcError::new(code::INVALID_REQUEST, "missing method")),
        },
        Err(e) => Err(RpcError::new(code::PARSE_ERROR, format!("invalid JSON: {e}"))),
    };
    let body = match result {
        Ok(value) => json!({ "result": value }),
        Err(error) => json!({ "error": error.to_json() }),
    }
    .to_string()
    .into_bytes();
    let mut response = Vec::with_capacity(body.len() + 4);
    response.extend_from_slice(&(body.len() as u32).to_le_bytes());
    response.extend_from_slice(&body);
    leak(response.into_boxed_slice())
}
