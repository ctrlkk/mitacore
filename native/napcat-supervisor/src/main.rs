use std::env;
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--lock")) {
        eprintln!("用法: napcat-supervisor --lock <path> -- <command> [args...]");
        return ExitCode::from(2);
    }
    let Some(lock_path) = args.next() else {
        eprintln!("缺少锁文件路径");
        return ExitCode::from(2);
    };
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--")) {
        eprintln!("缺少命令分隔符 --");
        return ExitCode::from(2);
    }

    let Some(command) = args.next() else {
        eprintln!("缺少要启动的命令");
        return ExitCode::from(2);
    };
    let args = args.collect::<Vec<_>>();

    let lock = match OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
    {
        Ok(lock) => lock,
        Err(error) => {
            eprintln!("无法打开实例锁: {error}");
            return ExitCode::from(1);
        }
    };
    if let Err(error) = fs2::FileExt::try_lock_exclusive(&lock) {
        eprintln!("NapCat 实例已在运行，无法获取实例锁: {error}");
        return ExitCode::from(1);
    }

    eprintln!("NAPCAT_SUPERVISOR_READY");
    if io::stderr().flush().is_err() || io::stdin().read_exact(&mut [0_u8]).is_err() {
        return ExitCode::from(1);
    }

    match platform::run(command, args) {
        Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
        Err(error) => {
            eprintln!("napcat-supervisor: {error}");
            ExitCode::from(1)
        }
    }
}

#[cfg(unix)]
mod platform {
    use std::ffi::OsString;
    use std::io::{self, Read};
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::process::{Command, Stdio};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::Duration;

    pub fn run(command: OsString, args: Vec<OsString>) -> io::Result<i32> {
        let mut child = unsafe {
            Command::new(command)
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                })
                .spawn()?
        };
        let process_group = child.id() as i32;
        let shutting_down = Arc::new(AtomicBool::new(false));
        let cancel_delayed_kill = Arc::new(AtomicBool::new(false));
        let monitor_shutting_down = Arc::clone(&shutting_down);
        let monitor_cancel_delayed_kill = Arc::clone(&cancel_delayed_kill);

        thread::spawn(move || {
            let mut buffer = [0_u8; 64];
            while let Ok(read) = io::stdin().read(&mut buffer) {
                if read == 0 {
                    break;
                }
            }

            monitor_shutting_down.store(true, Ordering::Release);
            unsafe {
                libc::kill(-process_group, libc::SIGTERM);
            }
            thread::sleep(Duration::from_secs(5));
            if !monitor_cancel_delayed_kill.load(Ordering::Acquire) {
                unsafe {
                    libc::kill(-process_group, libc::SIGKILL);
                }
            }
        });

        let status = child.wait()?;
        if shutting_down.load(Ordering::Acquire) {
            cancel_delayed_kill.store(true, Ordering::Release);
            // leader 已退出时立即清理剩余成员，避免延迟期间 PGID 被复用。
            unsafe {
                libc::kill(-process_group, libc::SIGKILL);
            }
        } else {
            // launcher 自行退出后仍可能留下 Electron 子进程。
            unsafe {
                libc::kill(-process_group, libc::SIGKILL);
            }
        }

        Ok(status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(1)))
    }
}

#[cfg(windows)]
mod platform {
    use std::ffi::{OsStr, OsString, c_void};
    use std::io::{self, Read};
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};
    use std::thread;
    use windows_sys::Win32::Foundation::{
        CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, GENERIC_READ, HANDLE,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        CREATE_SUSPENDED, CreateProcessW, DeleteProcThreadAttributeList,
        EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess, GetExitCodeProcess, INFINITE,
        InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES,
        STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
    };

    pub fn run(command: OsString, args: Vec<OsString>) -> io::Result<i32> {
        unsafe {
            let job = CreateJobObjectW(null(), null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }

            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                let error = io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }

            let nul_name = OsStr::new("NUL")
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let mut security: SECURITY_ATTRIBUTES = zeroed();
            security.nLength = size_of::<SECURITY_ATTRIBUTES>() as u32;
            security.bInheritHandle = 1;
            let nul = CreateFileW(
                nul_name.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                &security,
                OPEN_EXISTING,
                0,
                null_mut(),
            );
            if nul == INVALID_HANDLE_VALUE {
                let error = io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }

            let current_process = GetCurrentProcess();
            let stdout =
                match duplicate_inheritable(current_process, GetStdHandle(STD_OUTPUT_HANDLE)) {
                    Ok(handle) => handle,
                    Err(error) => {
                        CloseHandle(nul);
                        CloseHandle(job);
                        return Err(error);
                    }
                };
            let stderr =
                match duplicate_inheritable(current_process, GetStdHandle(STD_ERROR_HANDLE)) {
                    Ok(handle) => handle,
                    Err(error) => {
                        close_handles(&[nul, stdout, job]);
                        return Err(error);
                    }
                };

            let mut attribute_size = 0_usize;
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_size);
            let mut attribute_buffer = vec![0_u8; attribute_size];
            let attribute_list = attribute_buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
            if InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_size) == 0 {
                let error = io::Error::last_os_error();
                close_handles(&[nul, stdout, stderr, job]);
                return Err(error);
            }
            let inherited_handles = [nul, stdout, stderr];
            if UpdateProcThreadAttribute(
                attribute_list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                inherited_handles.as_ptr() as *const c_void,
                size_of::<[HANDLE; 3]>(),
                null_mut(),
                null(),
            ) == 0
            {
                let error = io::Error::last_os_error();
                DeleteProcThreadAttributeList(attribute_list);
                close_handles(&[nul, stdout, stderr, job]);
                return Err(error);
            }

            let mut startup: STARTUPINFOEXW = zeroed();
            startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = nul;
            startup.StartupInfo.hStdOutput = stdout;
            startup.StartupInfo.hStdError = stderr;
            startup.lpAttributeList = attribute_list;

            let mut process: PROCESS_INFORMATION = zeroed();
            let application = wide_null(&command);
            let mut command_line = std::iter::once(command.as_os_str())
                .chain(args.iter().map(OsString::as_os_str))
                .map(quote_windows_argument)
                .collect::<Vec<_>>()
                .join(" ")
                .encode_utf16()
                .chain(Some(0))
                .collect::<Vec<_>>();

            let created = CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                null(),
                null(),
                &startup.StartupInfo,
                &mut process,
            );
            DeleteProcThreadAttributeList(attribute_list);
            close_handles(&inherited_handles);
            if created == 0 {
                let error = io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }

            if AssignProcessToJobObject(job, process.hProcess) == 0 {
                let error = io::Error::last_os_error();
                TerminateJobObject(job, 1);
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
                CloseHandle(job);
                return Err(error);
            }
            if ResumeThread(process.hThread) == u32::MAX {
                let error = io::Error::last_os_error();
                TerminateJobObject(job, 1);
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
                CloseHandle(job);
                return Err(error);
            }
            CloseHandle(process.hThread);

            let monitor_job = job as usize;
            thread::spawn(move || {
                let mut buffer = [0_u8; 64];
                while let Ok(read) = io::stdin().read(&mut buffer) {
                    if read == 0 {
                        break;
                    }
                }
                TerminateJobObject(monitor_job as HANDLE, 1);
            });

            WaitForSingleObject(process.hProcess, INFINITE);
            let mut exit_code = 1_u32;
            GetExitCodeProcess(process.hProcess, &mut exit_code);
            // launcher 自行退出时，Job 中仍可能存在 NTQQ/Electron 子进程。
            TerminateJobObject(job, exit_code);
            CloseHandle(process.hProcess);
            CloseHandle(job);
            Ok(if exit_code == 0 { 0 } else { 1 })
        }
    }

    fn wide_null(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }

    unsafe fn duplicate_inheritable(process: HANDLE, handle: HANDLE) -> io::Result<HANDLE> {
        let mut duplicated = null_mut();
        if unsafe {
            DuplicateHandle(
                process,
                handle,
                process,
                &mut duplicated,
                0,
                1,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(duplicated)
    }

    unsafe fn close_handles(handles: &[HANDLE]) {
        handles.iter().for_each(|handle| unsafe {
            CloseHandle(*handle);
        });
    }

    fn quote_windows_argument(value: &OsStr) -> String {
        let value = value.to_string_lossy();
        if !value.is_empty()
            && !value
                .bytes()
                .any(|byte| matches!(byte, b' ' | b'\t' | b'"'))
        {
            return value.into_owned();
        }

        let mut quoted = String::from('"');
        let mut backslashes = 0;
        for ch in value.chars() {
            match ch {
                '\\' => backslashes += 1,
                '"' => {
                    quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                    quoted.push('"');
                    backslashes = 0;
                }
                _ => {
                    quoted.push_str(&"\\".repeat(backslashes));
                    quoted.push(ch);
                    backslashes = 0;
                }
            }
        }
        quoted.push_str(&"\\".repeat(backslashes * 2));
        quoted.push('"');
        quoted
    }
}
