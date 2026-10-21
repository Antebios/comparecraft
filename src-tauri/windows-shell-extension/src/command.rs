use super::*;

const IID_IEXPLORERCOMMAND: Guid = Guid::new(0xa08ce4d0, 0xfa25, 0x44ab, [0xb5, 0x7c, 0xc7, 0xb1, 0xc3, 0x23, 0xe0, 0xb9]);

#[repr(C)]
struct ExplorerCommand {
    vtable: *const CommandVTable,
    refs: AtomicU32,
    action: usize,
}

#[repr(C)]
struct CommandVTable {
    query: unsafe extern "system" fn(*mut ExplorerCommand, *const Guid, *mut *mut c_void) -> HResult,
    add_ref: unsafe extern "system" fn(*mut ExplorerCommand) -> u32,
    release: unsafe extern "system" fn(*mut ExplorerCommand) -> u32,
    title: unsafe extern "system" fn(*mut ExplorerCommand, *mut c_void, *mut *mut u16) -> HResult,
    icon: unsafe extern "system" fn(*mut ExplorerCommand, *mut c_void, *mut *mut u16) -> HResult,
    tooltip: unsafe extern "system" fn(*mut ExplorerCommand, *mut c_void, *mut *mut u16) -> HResult,
    name: unsafe extern "system" fn(*mut ExplorerCommand, *mut Guid) -> HResult,
    state: unsafe extern "system" fn(*mut ExplorerCommand, *mut c_void, i32, *mut u32) -> HResult,
    invoke: unsafe extern "system" fn(*mut ExplorerCommand, *mut c_void, *mut c_void) -> HResult,
    flags: unsafe extern "system" fn(*mut ExplorerCommand, *mut u32) -> HResult,
    children: unsafe extern "system" fn(*mut ExplorerCommand, *mut *mut c_void) -> HResult,
}

static VTABLE: CommandVTable = CommandVTable {
    query, add_ref, release, title, icon, tooltip: title, name, state, invoke, flags, children,
};

pub(super) fn action_for_class(class_id: Guid) -> Option<u32> {
    (0..comparecraft_menu::ACTIONS.len() as u32).find(|index| class_id == class_for_action(*index))
}

fn class_for_action(index: u32) -> Guid {
    Guid::new(0x5e8a1f40 + index, 0x92b3, 0x4b16, [0xa4, 0x21, 0x72, 0x4e, 0x3f, 0x8c, 0x20, 0x01])
}

pub(super) unsafe fn create(action: u32, iid: *const Guid, out: *mut *mut c_void) -> HResult {
    if *iid != IID_IUNKNOWN && *iid != IID_IEXPLORERCOMMAND { return E_NOINTERFACE; }
    let command = Box::into_raw(Box::new(ExplorerCommand { vtable: &VTABLE, refs: AtomicU32::new(1), action: action as usize }));
    OBJECTS.fetch_add(1, Ordering::Relaxed);
    *out = command.cast();
    S_OK
}

unsafe extern "system" fn query(this: *mut ExplorerCommand, iid: *const Guid, out: *mut *mut c_void) -> HResult {
    if iid.is_null() || out.is_null() { return E_FAIL; }
    *out = null_mut();
    if *iid != IID_IUNKNOWN && *iid != IID_IEXPLORERCOMMAND { return E_NOINTERFACE; }
    *out = this.cast();
    add_ref(this);
    S_OK
}

unsafe extern "system" fn add_ref(this: *mut ExplorerCommand) -> u32 {
    (*this).refs.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "system" fn release(this: *mut ExplorerCommand) -> u32 {
    let remaining = (*this).refs.fetch_sub(1, Ordering::Release) - 1;
    if remaining == 0 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(this));
        OBJECTS.fetch_sub(1, Ordering::Release);
    }
    remaining
}

unsafe fn string_result(value: &str, out: *mut *mut u16) -> HResult {
    if out.is_null() { return E_FAIL; }
    *out = null_mut();
    let encoded: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
    let memory = co_task_mem_alloc(encoded.len() * size_of::<u16>()).cast::<u16>();
    if memory.is_null() { return E_FAIL; }
    std::ptr::copy_nonoverlapping(encoded.as_ptr(), memory, encoded.len());
    *out = memory;
    S_OK
}

unsafe extern "system" fn title(this: *mut ExplorerCommand, _: *mut c_void, out: *mut *mut u16) -> HResult {
    string_result(comparecraft_menu::ACTIONS[(*this).action].label, out)
}

unsafe extern "system" fn icon(this: *mut ExplorerCommand, selection: *mut c_void, out: *mut *mut u16) -> HResult {
    let paths = selected_paths(selection).unwrap_or_default();
    let action = &comparecraft_menu::ACTIONS[(*this).action];
    let folder = paths.first().is_some_and(|path| path.is_dir());
    let index = match action.id {
        "clearLeft" | "clearLeftFolder" => 131,
        "sync" => 238,
        "merge" => 165,
        _ if folder => 3,
        _ => 1,
    };
    string_result(&format!("shell32.dll,{index}"), out)
}

unsafe extern "system" fn name(this: *mut ExplorerCommand, out: *mut Guid) -> HResult {
    if out.is_null() { return E_FAIL; }
    *out = class_for_action((*this).action as u32);
    S_OK
}

unsafe extern "system" fn state(this: *mut ExplorerCommand, selection: *mut c_void, _: i32, out: *mut u32) -> HResult {
    if out.is_null() { return E_FAIL; }
    *out = 2;
    if let Ok(paths) = selected_paths(selection) {
        if comparecraft_menu::visible(&comparecraft_menu::config_dir(), &paths) & (1 << (*this).action) != 0 { *out = 0; }
    }
    S_OK
}

unsafe extern "system" fn invoke(this: *mut ExplorerCommand, selection: *mut c_void, _: *mut c_void) -> HResult {
    match selected_paths(selection) {
        Ok(paths) if comparecraft_menu::activate((*this).action, &paths).is_ok() => S_OK,
        _ => E_FAIL,
    }
}

unsafe extern "system" fn flags(_: *mut ExplorerCommand, out: *mut u32) -> HResult {
    if out.is_null() { return E_FAIL; }
    *out = 0;
    S_OK
}

unsafe extern "system" fn children(_: *mut ExplorerCommand, out: *mut *mut c_void) -> HResult {
    if out.is_null() { return E_FAIL; }
    *out = null_mut();
    0x8000_4001u32 as i32
}

unsafe fn selected_paths(selection: *mut c_void) -> Result<Vec<PathBuf>, ()> {
    if selection.is_null() { return Err(()); }
    let array = *(selection.cast::<*const *const c_void>());
    let get_count: unsafe extern "system" fn(*mut c_void, *mut u32) -> HResult = std::mem::transmute(*array.add(7));
    let get_item: unsafe extern "system" fn(*mut c_void, u32, *mut *mut c_void) -> HResult = std::mem::transmute(*array.add(8));
    let mut count = 0;
    if get_count(selection, &mut count) < 0 || count == 0 || count > 2 { return Err(()); }
    let mut paths = Vec::new();
    for index in 0..count {
        let mut item = null_mut();
        if get_item(selection, index, &mut item) < 0 || item.is_null() { return Err(()); }
        let table = *(item.cast::<*const *const c_void>());
        let display_name: unsafe extern "system" fn(*mut c_void, u32, *mut *mut u16) -> HResult = std::mem::transmute(*table.add(5));
        let release_item: unsafe extern "system" fn(*mut c_void) -> u32 = std::mem::transmute(*table.add(2));
        let mut value = null_mut();
        let result = display_name(item, 0x8005_8000, &mut value);
        release_item(item);
        if result < 0 || value.is_null() { return Err(()); }
        let mut length = 0;
        while length < 32768 && *value.add(length) != 0 { length += 1; }
        let decoded = if length < 32768 { String::from_utf16(std::slice::from_raw_parts(value, length)).ok() } else { None };
        co_task_mem_free(value.cast());
        paths.push(PathBuf::from(decoded.ok_or(())?));
    }
    Ok(paths)
}

#[link(name = "ole32")]
extern "system" {
    #[link_name = "CoTaskMemAlloc"] fn co_task_mem_alloc(size: usize) -> *mut c_void;
    #[link_name = "CoTaskMemFree"] fn co_task_mem_free(memory: *mut c_void);
}