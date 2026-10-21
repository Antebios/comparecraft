#![cfg(any(target_os = "windows", test))]

use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::path::PathBuf;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU32, Ordering};

mod command;

type HResult = i32;
type Hwnd = *mut c_void;
type Handle = *mut c_void;

const S_OK: HResult = 0;
const S_FALSE: HResult = 1;
const E_NOINTERFACE: HResult = 0x8000_4002u32 as i32;
const CLASS_E_CLASSNOTAVAILABLE: HResult = 0x8004_0111u32 as i32;
const CLASS_E_NOAGGREGATION: HResult = 0x8004_0110u32 as i32;
const E_FAIL: HResult = 0x8000_4005u32 as i32;
const DROPEFFECT_COPY: u32 = 1;
const CF_HDROP: u16 = 15;
const DVASPECT_CONTENT: u32 = 1;
const TYMED_HGLOBAL: u32 = 1;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const IID_IUNKNOWN: Guid = Guid::new(0, 0, 0, [0xc0, 0, 0, 0, 0, 0, 0, 0x46]);
const IID_ICLASSFACTORY: Guid = Guid::new(1, 0, 0, [0xc0, 0, 0, 0, 0, 0, 0, 0x46]);
const IID_IDROPTARGET: Guid = Guid::new(0x122, 0, 0, [0xc0, 0, 0, 0, 0, 0, 0, 0x46]);
const CLSID_COMPARE: Guid = Guid::new(
    0x5e8a1f31,
    0x92b3,
    0x4b16,
    [0xa4, 0x21, 0x72, 0x4e, 0x3f, 0x8c, 0x10, 0x01],
);
const CLSID_SYNC: Guid = Guid::new(
    0x5e8a1f32,
    0x92b3,
    0x4b16,
    [0xa4, 0x21, 0x72, 0x4e, 0x3f, 0x8c, 0x10, 0x02],
);
const CLSID_MERGE: Guid = Guid::new(
    0x5e8a1f33,
    0x92b3,
    0x4b16,
    [0xa4, 0x21, 0x72, 0x4e, 0x3f, 0x8c, 0x10, 0x03],
);

static OBJECTS: AtomicU32 = AtomicU32::new(0);
static SERVER_LOCKS: AtomicU32 = AtomicU32::new(0);

#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

impl Guid {
    const fn new(data1: u32, data2: u16, data3: u16, data4: [u8; 8]) -> Self {
        Self {
            data1,
            data2,
            data3,
            data4,
        }
    }
}

#[repr(C)]
struct Unknown {
    vtable: *const UnknownVTable,
}

#[repr(C)]
struct UnknownVTable {
    query_interface:
        unsafe extern "system" fn(*mut Unknown, *const Guid, *mut *mut c_void) -> HResult,
    add_ref: unsafe extern "system" fn(*mut Unknown) -> u32,
    release: unsafe extern "system" fn(*mut Unknown) -> u32,
}

#[repr(C)]
struct DataObject {
    vtable: *const DataObjectVTable,
}

#[repr(C)]
struct DataObjectVTable {
    query_interface:
        unsafe extern "system" fn(*mut DataObject, *const Guid, *mut *mut c_void) -> HResult,
    add_ref: unsafe extern "system" fn(*mut DataObject) -> u32,
    release: unsafe extern "system" fn(*mut DataObject) -> u32,
    get_data:
        unsafe extern "system" fn(*mut DataObject, *const FormatEtc, *mut StorageMedium) -> HResult,
}

#[repr(C)]
struct DropTarget {
    vtable: *const DropTargetVTable,
    refs: AtomicU32,
    action: u32,
}

#[repr(C)]
struct DropTargetVTable {
    query_interface:
        unsafe extern "system" fn(*mut DropTarget, *const Guid, *mut *mut c_void) -> HResult,
    add_ref: unsafe extern "system" fn(*mut DropTarget) -> u32,
    release: unsafe extern "system" fn(*mut DropTarget) -> u32,
    drag_enter: unsafe extern "system" fn(
        *mut DropTarget,
        *mut DataObject,
        u32,
        Point,
        *mut u32,
    ) -> HResult,
    drag_over: unsafe extern "system" fn(*mut DropTarget, u32, Point, *mut u32) -> HResult,
    drag_leave: unsafe extern "system" fn(*mut DropTarget) -> HResult,
    drop: unsafe extern "system" fn(
        *mut DropTarget,
        *mut DataObject,
        u32,
        Point,
        *mut u32,
    ) -> HResult,
}

#[repr(C)]
struct ClassFactory {
    vtable: *const ClassFactoryVTable,
    refs: AtomicU32,
    action: u32,
}

#[repr(C)]
struct ClassFactoryVTable {
    query_interface:
        unsafe extern "system" fn(*mut ClassFactory, *const Guid, *mut *mut c_void) -> HResult,
    add_ref: unsafe extern "system" fn(*mut ClassFactory) -> u32,
    release: unsafe extern "system" fn(*mut ClassFactory) -> u32,
    create_instance: unsafe extern "system" fn(
        *mut ClassFactory,
        *mut Unknown,
        *const Guid,
        *mut *mut c_void,
    ) -> HResult,
    lock_server: unsafe extern "system" fn(*mut ClassFactory, i32) -> HResult,
}

#[repr(C)]
struct FormatEtc {
    format: u16,
    target_device: *mut c_void,
    aspect: u32,
    index: i32,
    tymed: u32,
}

#[repr(C)]
struct StorageMedium {
    tymed: u32,
    value: *mut c_void,
    release: *mut Unknown,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: i32,
    y: i32,
}

#[repr(C)]
struct StartupInfo {
    cb: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    x_size: u32,
    y_size: u32,
    x_count_chars: u32,
    y_count_chars: u32,
    fill_attribute: u32,
    flags: u32,
    show_window: u16,
    reserved2_size: u16,
    reserved2: *mut u8,
    std_input: Handle,
    std_output: Handle,
    std_error: Handle,
}

#[repr(C)]
struct ProcessInformation {
    process: Handle,
    thread: Handle,
    process_id: u32,
    thread_id: u32,
}

static DROP_TARGET_VTABLE: DropTargetVTable = DropTargetVTable {
    query_interface: drop_target_query_interface,
    add_ref: drop_target_add_ref,
    release: drop_target_release,
    drag_enter: drop_target_drag_enter,
    drag_over: drop_target_drag_over,
    drag_leave: drop_target_drag_leave,
    drop: drop_target_drop,
};

static CLASS_FACTORY_VTABLE: ClassFactoryVTable = ClassFactoryVTable {
    query_interface: class_factory_query_interface,
    add_ref: class_factory_add_ref,
    release: class_factory_release,
    create_instance: class_factory_create_instance,
    lock_server: class_factory_lock_server,
};

#[no_mangle]
pub unsafe extern "system" fn DllCanUnloadNow() -> HResult {
    if OBJECTS.load(Ordering::Acquire) == 0 && SERVER_LOCKS.load(Ordering::Acquire) == 0 {
        S_OK
    } else {
        S_FALSE
    }
}

#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    class_id: *const Guid,
    interface_id: *const Guid,
    out: *mut *mut c_void,
) -> HResult {
    if class_id.is_null() || interface_id.is_null() || out.is_null() {
        return E_FAIL;
    }
    *out = null_mut();
    let Some(action) = action_for_class(*class_id) else {
        return CLASS_E_CLASSNOTAVAILABLE;
    };
    let factory = Box::into_raw(Box::new(ClassFactory {
        vtable: &CLASS_FACTORY_VTABLE,
        refs: AtomicU32::new(1),
        action,
    }));
    OBJECTS.fetch_add(1, Ordering::Relaxed);
    let result = class_factory_query_interface(factory, interface_id, out);
    class_factory_release(factory);
    result
}

unsafe fn action_for_class(class_id: Guid) -> Option<u32> {
    if let Some(index) = command::action_for_class(class_id) { return Some(100 + index); }
    if class_id == CLSID_COMPARE {
        Some(0)
    } else if class_id == CLSID_SYNC {
        Some(1)
    } else if class_id == CLSID_MERGE {
        Some(2)
    } else {
        None
    }
}

unsafe extern "system" fn class_factory_query_interface(
    this: *mut ClassFactory,
    iid: *const Guid,
    out: *mut *mut c_void,
) -> HResult {
    if out.is_null() || iid.is_null() {
        return E_FAIL;
    }
    *out = null_mut();
    if *iid != IID_IUNKNOWN && *iid != IID_ICLASSFACTORY {
        return E_NOINTERFACE;
    }
    *out = this.cast();
    class_factory_add_ref(this);
    S_OK
}

unsafe extern "system" fn class_factory_add_ref(this: *mut ClassFactory) -> u32 {
    (*this).refs.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "system" fn class_factory_release(this: *mut ClassFactory) -> u32 {
    let refs = (*this).refs.fetch_sub(1, Ordering::Release) - 1;
    if refs == 0 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(this));
        OBJECTS.fetch_sub(1, Ordering::Release);
    }
    refs
}

unsafe extern "system" fn class_factory_create_instance(
    this: *mut ClassFactory,
    outer: *mut Unknown,
    iid: *const Guid,
    out: *mut *mut c_void,
) -> HResult {
    if out.is_null() || iid.is_null() {
        return E_FAIL;
    }
    *out = null_mut();
    if !outer.is_null() {
        return CLASS_E_NOAGGREGATION;
    }
    if (*this).action >= 100 {
        return command::create((*this).action - 100, iid, out);
    }
    if *iid != IID_IUNKNOWN && *iid != IID_IDROPTARGET {
        return E_NOINTERFACE;
    }
    let target = Box::into_raw(Box::new(DropTarget {
        vtable: &DROP_TARGET_VTABLE,
        refs: AtomicU32::new(1),
        action: (*this).action,
    }));
    OBJECTS.fetch_add(1, Ordering::Relaxed);
    *out = target.cast();
    S_OK
}

unsafe extern "system" fn class_factory_lock_server(
    _this: *mut ClassFactory,
    lock: i32,
) -> HResult {
    if lock != 0 {
        SERVER_LOCKS.fetch_add(1, Ordering::Relaxed);
    } else {
        let _ = SERVER_LOCKS.fetch_update(Ordering::Release, Ordering::Relaxed, |count| {
            count.checked_sub(1)
        });
    }
    S_OK
}

unsafe extern "system" fn drop_target_query_interface(
    this: *mut DropTarget,
    iid: *const Guid,
    out: *mut *mut c_void,
) -> HResult {
    if out.is_null() || iid.is_null() {
        return E_FAIL;
    }
    *out = null_mut();
    if *iid != IID_IUNKNOWN && *iid != IID_IDROPTARGET {
        return E_NOINTERFACE;
    }
    *out = this.cast();
    drop_target_add_ref(this);
    S_OK
}

unsafe extern "system" fn drop_target_add_ref(this: *mut DropTarget) -> u32 {
    (*this).refs.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "system" fn drop_target_release(this: *mut DropTarget) -> u32 {
    let refs = (*this).refs.fetch_sub(1, Ordering::Release) - 1;
    if refs == 0 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(this));
        OBJECTS.fetch_sub(1, Ordering::Release);
    }
    refs
}

unsafe extern "system" fn drop_target_drag_enter(
    _this: *mut DropTarget,
    _data: *mut DataObject,
    _keys: u32,
    _point: Point,
    effect: *mut u32,
) -> HResult {
    if !effect.is_null() {
        *effect = DROPEFFECT_COPY;
    }
    S_OK
}

unsafe extern "system" fn drop_target_drag_over(
    _this: *mut DropTarget,
    _keys: u32,
    _point: Point,
    effect: *mut u32,
) -> HResult {
    if !effect.is_null() {
        *effect = DROPEFFECT_COPY;
    }
    S_OK
}

unsafe extern "system" fn drop_target_drag_leave(_this: *mut DropTarget) -> HResult {
    S_OK
}

unsafe extern "system" fn drop_target_drop(
    this: *mut DropTarget,
    data: *mut DataObject,
    _keys: u32,
    _point: Point,
    effect: *mut u32,
) -> HResult {
    if !effect.is_null() {
        *effect = 0;
    }
    if data.is_null() {
        return E_FAIL;
    }

    let format = FormatEtc {
        format: CF_HDROP,
        target_device: null_mut(),
        aspect: DVASPECT_CONTENT,
        index: -1,
        tymed: TYMED_HGLOBAL,
    };
    let mut medium: StorageMedium = zeroed();
    let result = ((*(*data).vtable).get_data)(data, &format, &mut medium);
    if result < 0 {
        return result;
    }
    let paths = paths_from_hdrop(medium.value);
    release_stg_medium(&mut medium);
    match paths {
        Ok(paths) if !paths.is_empty() => {
            if launch_comparecraft((*this).action, &paths).is_ok() {
                S_OK
            } else {
                E_FAIL
            }
        }
        Ok(_) => S_OK,
        Err(_) => E_FAIL,
    }
}

unsafe fn paths_from_hdrop(hdrop: Handle) -> Result<Vec<String>, ()> {
    if hdrop.is_null() {
        return Err(());
    }
    let count = drag_query_file_w(hdrop, u32::MAX, null_mut(), 0);
    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
        let length = drag_query_file_w(hdrop, index, null_mut(), 0) as usize;
        if length == 0 {
            return Err(());
        }
        let mut buffer = vec![0u16; length + 1];
        let written = drag_query_file_w(hdrop, index, buffer.as_mut_ptr(), buffer.len() as u32);
        if written == 0 || written as usize > length {
            return Err(());
        }
        buffer.truncate(written as usize);
        paths.push(String::from_utf16(&buffer).map_err(|_| ())?);
    }
    Ok(paths)
}

unsafe fn launch_comparecraft(action: u32, paths: &[String]) -> Result<(), ()> {
    let mut module: Handle = null_mut();
    if get_module_handle_ex_w(
        0x6,
        DllGetClassObject as *const () as *const u16,
        &mut module,
    ) == 0
    {
        return Err(());
    }
    let mut module_path = vec![0u16; 32768];
    let length = get_module_file_name_w(module, module_path.as_mut_ptr(), module_path.len() as u32);
    if length == 0 || length as usize >= module_path.len() {
        return Err(());
    }
    module_path.truncate(length as usize);
    let dll_path = PathBuf::from(String::from_utf16(&module_path).map_err(|_| ())?);
    let exe = dll_path.parent().ok_or(())?.join("comparecraft.exe");
    let executable = exe.to_string_lossy().into_owned();
    let action_flag = match action {
        0 => "-cc-compare",
        1 => "-cc-sync",
        2 => "-cc-merge",
        _ => return Err(()),
    };
    let mut command_line = quote_argument(&executable);
    command_line.push(' ');
    command_line.push_str(action_flag);
    for path in paths {
        command_line.push(' ');
        command_line.push_str(&quote_argument(path));
    }
    let mut command_line: Vec<u16> = command_line.encode_utf16().chain([0]).collect();
    let mut startup: StartupInfo = zeroed();
    startup.cb = size_of::<StartupInfo>() as u32;
    let mut process: ProcessInformation = zeroed();
    let created = create_process_w(
        null(),
        command_line.as_mut_ptr(),
        null_mut(),
        null_mut(),
        0,
        CREATE_NO_WINDOW,
        null_mut(),
        null(),
        &mut startup,
        &mut process,
    );
    if created == 0 {
        let code = get_last_error();
        show_error(code);
        return Err(());
    }
    close_handle(process.thread);
    close_handle(process.process);
    Ok(())
}

fn quote_argument(argument: &str) -> String {
    let mut quoted = String::from("\"");
    let mut slashes = 0;
    for ch in argument.chars() {
        match ch {
            '\\' => slashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(slashes * 2 + 1));
                quoted.push('"');
                slashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(slashes));
                quoted.push(ch);
                slashes = 0;
            }
        }
    }
    quoted.push_str(&"\\".repeat(slashes * 2));
    quoted.push('"');
    quoted
}

unsafe fn show_error(code: u32) {
    let message: Vec<u16> = format!(
        "CompareCraft could not be started from the Explorer context menu (Windows error {code})."
    )
    .encode_utf16()
    .chain([0])
    .collect();
    let title: Vec<u16> = "CompareCraft".encode_utf16().chain([0]).collect();
    message_box_w(null_mut(), message.as_ptr(), title.as_ptr(), 0x10);
}

#[link(name = "ole32")]
unsafe extern "system" {
    fn ReleaseStgMedium(medium: *mut StorageMedium);
}

#[link(name = "shell32")]
unsafe extern "system" {
    fn DragQueryFileW(hdrop: Handle, file: u32, path: *mut u16, capacity: u32) -> u32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleExW(flags: u32, name_or_address: *const u16, module: *mut Handle) -> i32;
    fn GetModuleFileNameW(module: Handle, path: *mut u16, capacity: u32) -> u32;
    #[cfg(test)]
    fn GlobalAlloc(flags: u32, bytes: usize) -> Handle;
    #[cfg(test)]
    fn GlobalLock(memory: Handle) -> *mut c_void;
    #[cfg(test)]
    fn GlobalUnlock(memory: Handle) -> i32;
    #[cfg(test)]
    fn GlobalFree(memory: Handle) -> Handle;
    fn CreateProcessW(
        application: *const u16,
        command_line: *mut u16,
        process_attributes: *mut c_void,
        thread_attributes: *mut c_void,
        inherit_handles: i32,
        creation_flags: u32,
        environment: *mut c_void,
        current_directory: *const u16,
        startup: *mut StartupInfo,
        process: *mut ProcessInformation,
    ) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetLastError() -> u32;
}

#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBoxW(hwnd: Hwnd, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

unsafe fn release_stg_medium(medium: *mut StorageMedium) {
    ReleaseStgMedium(medium);
}

unsafe fn drag_query_file_w(hdrop: Handle, file: u32, path: *mut u16, capacity: u32) -> u32 {
    DragQueryFileW(hdrop, file, path, capacity)
}

unsafe fn get_module_file_name_w(module: Handle, path: *mut u16, capacity: u32) -> u32 {
    GetModuleFileNameW(module, path, capacity)
}

unsafe fn get_module_handle_ex_w(
    flags: u32,
    name_or_address: *const u16,
    module: *mut Handle,
) -> i32 {
    GetModuleHandleExW(flags, name_or_address, module)
}

unsafe fn create_process_w(
    application: *const u16,
    command_line: *mut u16,
    process_attributes: *mut c_void,
    thread_attributes: *mut c_void,
    inherit_handles: i32,
    creation_flags: u32,
    environment: *mut c_void,
    current_directory: *const u16,
    startup: *mut StartupInfo,
    process: *mut ProcessInformation,
) -> i32 {
    CreateProcessW(
        application,
        command_line,
        process_attributes,
        thread_attributes,
        inherit_handles,
        creation_flags,
        environment,
        current_directory,
        startup,
        process,
    )
}

unsafe fn close_handle(handle: Handle) {
    CloseHandle(handle);
}

unsafe fn get_last_error() -> u32 {
    GetLastError()
}

unsafe fn message_box_w(hwnd: Hwnd, text: *const u16, caption: *const u16, kind: u32) -> i32 {
    MessageBoxW(hwnd, text, caption, kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[repr(C)]
    struct DropFiles {
        file_offset: u32,
        point: Point,
        non_client: i32,
        wide: i32,
    }

    #[test]
    fn registered_classes_create_action_specific_drop_targets() {
        unsafe {
            for (class_id, action) in [(CLSID_COMPARE, 0), (CLSID_SYNC, 1), (CLSID_MERGE, 2)] {
                let mut factory_out = null_mut();
                assert_eq!(
                    DllGetClassObject(&class_id, &IID_ICLASSFACTORY, &mut factory_out),
                    S_OK
                );
                let factory = factory_out.cast::<ClassFactory>();
                let mut target_out = null_mut();
                assert_eq!(
                    ((*(*factory).vtable).create_instance)(
                        factory,
                        null_mut(),
                        &IID_IDROPTARGET,
                        &mut target_out,
                    ),
                    S_OK
                );
                let target = target_out.cast::<DropTarget>();
                assert_eq!((*target).action, action);
                ((*(*target).vtable).release)(target);
                ((*(*factory).vtable).release)(factory);
            }
            assert_eq!(DllCanUnloadNow(), S_OK);
        }
    }

    #[test]
    fn reads_all_paths_from_explorer_hdrop_data() {
        unsafe {
            let file_names = [
                r"C:\Folder With Spaces\first.txt",
                r"C:\Other Folder\second.txt",
            ];
            let mut names = Vec::new();
            for name in file_names {
                names.extend(name.encode_utf16());
                names.push(0);
            }
            names.push(0);

            let header = DropFiles {
                file_offset: size_of::<DropFiles>() as u32,
                point: Point { x: 0, y: 0 },
                non_client: 0,
                wide: 1,
            };
            let bytes = size_of::<DropFiles>() + names.len() * size_of::<u16>();
            let memory = GlobalAlloc(0x42, bytes);
            assert!(!memory.is_null());
            let target = GlobalLock(memory).cast::<u8>();
            assert!(!target.is_null());
            std::ptr::copy_nonoverlapping(
                (&header as *const DropFiles).cast::<u8>(),
                target,
                size_of::<DropFiles>(),
            );
            std::ptr::copy_nonoverlapping(
                names.as_ptr().cast::<u8>(),
                target.add(size_of::<DropFiles>()),
                names.len() * size_of::<u16>(),
            );
            let paths = paths_from_hdrop(memory).unwrap();
            assert_eq!(paths, file_names);
            GlobalUnlock(memory);
            assert!(GlobalFree(memory).is_null());
        }
    }

    #[test]
    fn quotes_windows_arguments_with_spaces_and_trailing_slashes() {
        assert_eq!(
            quote_argument(r"C:\folder\file.txt"),
            r#""C:\folder\file.txt""#
        );
        assert_eq!(
            quote_argument(r"C:\folder with spaces\"),
            r#""C:\folder with spaces\\""#
        );
        assert_eq!(quote_argument(r#"a"b"#), r#""a\"b""#);
    }
}
