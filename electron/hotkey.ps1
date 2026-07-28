[CmdletBinding()]
param(
    [switch]$SelfTest,
    [switch]$NoSuppress,
    [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace Koekaki.Desktop
{
    public static class RightAltHook
    {
        private const int WH_KEYBOARD_LL = 13;
        private const int HC_ACTION = 0;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_KEYUP = 0x0101;
        private const int WM_SYSKEYDOWN = 0x0104;
        private const int WM_SYSKEYUP = 0x0105;
        private const int WM_QUIT = 0x0012;
        private const uint PM_NOREMOVE = 0x0000;
        private const uint VK_RMENU = 0xA5;
        private const uint INPUT_KEYBOARD = 1;
        private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint LLKHF_INJECTED = 0x00000010;

        private static LowLevelKeyboardProc callback;
        private static IntPtr hookId = IntPtr.Zero;
        private static uint ownerThreadId;
        private static bool selfTest;
        private static bool suppress;
        private static int rightAltDown;
        private static int rightAltEventCount;
        private static int selfTestObserved;
        private static int selfTestFinished;
        private static int exitCode;
        private static int parentProcessId;

        public static int Run(bool runSelfTest, bool suppressRightAlt, int watchedParentPid)
        {
            selfTest = runSelfTest;
            suppress = suppressRightAlt;
            rightAltDown = 0;
            rightAltEventCount = 0;
            selfTestObserved = 0;
            selfTestFinished = 0;
            exitCode = runSelfTest ? 1 : 0;
            parentProcessId = watchedParentPid;
            ownerThreadId = GetCurrentThreadId();
            callback = HookCallback;

            MSG queueMessage;
            PeekMessage(out queueMessage, IntPtr.Zero, 0, 0, PM_NOREMOVE);

            IntPtr moduleHandle = GetModuleHandle(null);
            hookId = SetWindowsHookEx(WH_KEYBOARD_LL, callback, moduleHandle, 0);
            if (hookId == IntPtr.Zero)
            {
                int error = Marshal.GetLastWin32Error();
                Console.Error.WriteLine("HOOK_INSTALL_FAILED " + error);
                return 1;
            }

            Console.WriteLine("READY");
            Console.Out.Flush();

            if (selfTest)
            {
                Thread testThread = new Thread(SelfTestWorker);
                testThread.IsBackground = true;
                testThread.Name = "KoekakiRightAltSelfTest";
                testThread.Start();
            }

            if (parentProcessId > 0)
            {
                Thread parentThread = new Thread(ParentWatchWorker);
                parentThread.IsBackground = true;
                parentThread.Name = "KoekakiParentWatch";
                parentThread.Start();
            }

            try
            {
                MSG message;
                int result;
                while ((result = GetMessage(out message, IntPtr.Zero, 0, 0)) > 0)
                {
                    TranslateMessage(ref message);
                    DispatchMessage(ref message);
                }

                if (result < 0)
                {
                    int error = Marshal.GetLastWin32Error();
                    Console.Error.WriteLine("MESSAGE_LOOP_FAILED " + error);
                    return 1;
                }

                return exitCode;
            }
            finally
            {
                if (hookId != IntPtr.Zero)
                {
                    UnhookWindowsHookEx(hookId);
                    hookId = IntPtr.Zero;
                }

                GC.KeepAlive(callback);
            }
        }

        private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode == HC_ACTION)
            {
                KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(
                    lParam,
                    typeof(KBDLLHOOKSTRUCT)
                );

                int message = unchecked((int)wParam.ToInt64());
                bool isKeyDown = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
                bool isKeyUp = message == WM_KEYUP || message == WM_SYSKEYUP;
                bool isInjected = (data.flags & LLKHF_INJECTED) != 0;

                if (data.vkCode == VK_RMENU && (isKeyDown || isKeyUp))
                {
                    if (isInjected && !selfTest)
                    {
                        return CallNextHookEx(hookId, nCode, wParam, lParam);
                    }

                    if (isKeyDown && Interlocked.Exchange(ref rightAltDown, 1) == 0)
                    {
                        Interlocked.Increment(ref rightAltEventCount);
                        Console.WriteLine("RIGHT_ALT");
                        Console.Out.Flush();

                        if (selfTest && isInjected)
                        {
                            Interlocked.Exchange(ref selfTestObserved, 1);
                        }
                    }
                    else if (isKeyUp)
                    {
                        Interlocked.Exchange(ref rightAltDown, 0);

                        if (selfTest && Interlocked.CompareExchange(ref selfTestObserved, 0, 0) == 1)
                        {
                            bool singleToggle = Interlocked.CompareExchange(
                                ref rightAltEventCount,
                                0,
                                0
                            ) == 1;
                            FinishSelfTest(
                                singleToggle,
                                singleToggle ? "SELF_TEST_OK" : "SELF_TEST_REPEAT_FAILED"
                            );
                        }
                    }

                    if (suppress)
                    {
                        return new IntPtr(1);
                    }
                }
            }

            return CallNextHookEx(hookId, nCode, wParam, lParam);
        }

        private static void SelfTestWorker()
        {
            Thread.Sleep(250);

            INPUT[] inputs = new INPUT[3];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].U.ki.wVk = (ushort)VK_RMENU;
            inputs[0].U.ki.dwFlags = KEYEVENTF_EXTENDEDKEY;
            inputs[1].type = INPUT_KEYBOARD;
            inputs[1].U.ki.wVk = (ushort)VK_RMENU;
            inputs[1].U.ki.dwFlags = KEYEVENTF_EXTENDEDKEY;
            inputs[2].type = INPUT_KEYBOARD;
            inputs[2].U.ki.wVk = (ushort)VK_RMENU;
            inputs[2].U.ki.dwFlags = KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP;

            uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Length)
            {
                int error = Marshal.GetLastWin32Error();
                if (sent > 0)
                {
                    INPUT[] release = new INPUT[1];
                    release[0].type = INPUT_KEYBOARD;
                    release[0].U.ki.wVk = (ushort)VK_RMENU;
                    release[0].U.ki.dwFlags = KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP;
                    SendInput(1, release, Marshal.SizeOf(typeof(INPUT)));
                }
                FinishSelfTest(false, "SELF_TEST_SEND_FAILED " + error);
                return;
            }

            Thread.Sleep(3000);
            FinishSelfTest(false, "SELF_TEST_TIMEOUT");
        }

        private static void ParentWatchWorker()
        {
            try
            {
                using (Process parent = Process.GetProcessById(parentProcessId))
                {
                    parent.WaitForExit();
                }
            }
            catch (ArgumentException)
            {
            }
            catch (InvalidOperationException)
            {
            }

            PostThreadMessage(ownerThreadId, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
        }

        private static void FinishSelfTest(bool success, string message)
        {
            if (Interlocked.CompareExchange(ref selfTestFinished, 1, 0) != 0)
            {
                return;
            }

            exitCode = success ? 0 : 1;
            if (success)
            {
                Console.WriteLine(message);
                Console.Out.Flush();
            }
            else
            {
                Console.Error.WriteLine(message);
            }

            if (GetCurrentThreadId() == ownerThreadId)
            {
                PostQuitMessage(0);
            }
            else
            {
                PostThreadMessage(ownerThreadId, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
            }
        }

        private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public UIntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int x;
            public int y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public UIntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public POINT pt;
            public uint lPrivate;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint type;
            public INPUTUNION U;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct INPUTUNION
        {
            [FieldOffset(0)]
            public MOUSEINPUT mi;

            [FieldOffset(0)]
            public KEYBDINPUT ki;

            [FieldOffset(0)]
            public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public UIntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public UIntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct HARDWAREINPUT
        {
            public uint uMsg;
            public ushort wParamL;
            public ushort wParamH;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(
            int idHook,
            LowLevelKeyboardProc lpfn,
            IntPtr hMod,
            uint dwThreadId
        );

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(
            IntPtr hhk,
            int nCode,
            IntPtr wParam,
            IntPtr lParam
        );

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int GetMessage(
            out MSG lpMsg,
            IntPtr hWnd,
            uint wMsgFilterMin,
            uint wMsgFilterMax
        );

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TranslateMessage(ref MSG lpMsg);

        [DllImport("user32.dll")]
        private static extern IntPtr DispatchMessage(ref MSG lpMsg);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PeekMessage(
            out MSG lpMsg,
            IntPtr hWnd,
            uint wMsgFilterMin,
            uint wMsgFilterMax,
            uint wRemoveMsg
        );

        [DllImport("user32.dll")]
        private static extern void PostQuitMessage(int nExitCode);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PostThreadMessage(
            uint idThread,
            uint Msg,
            UIntPtr wParam,
            IntPtr lParam
        );

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(
            uint nInputs,
            INPUT[] pInputs,
            int cbSize
        );

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);
    }
}
'@

try {
    Add-Type -TypeDefinition $source -Language CSharp
    $exitCode = [Koekaki.Desktop.RightAltHook]::Run(
        $SelfTest.IsPresent,
        -not $NoSuppress.IsPresent,
        $ParentPid
    )
    exit $exitCode
}
catch {
    [Console]::Error.WriteLine('HOTKEY_FATAL ' + $_.Exception.Message)
    exit 1
}
