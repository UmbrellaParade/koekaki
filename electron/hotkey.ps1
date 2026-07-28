[CmdletBinding()]
param(
    [switch]$SelfTest,
    [switch]$Paste,
    [switch]$PasteSelfTest,
    [switch]$NoSuppress,
    [int]$ParentPid = 0,
    [long]$TargetHandle = 0,
    [uint32]$TargetProcessId = 0,
    [uint32]$TargetThreadId = 0,
    [uint32]$OwnerProcessId = 0
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
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
                        IntPtr foreground = GetForegroundWindow();
                        uint processId;
                        uint threadId = GetWindowThreadProcessId(foreground, out processId);
                        Console.WriteLine(
                            "RIGHT_ALT " +
                            foreground.ToInt64().ToString(CultureInfo.InvariantCulture) + " " +
                            processId.ToString(CultureInfo.InvariantCulture) + " " +
                            threadId.ToString(CultureInfo.InvariantCulture)
                        );
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
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
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
        private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);
    }

    public enum PasteState
    {
        Ready = 0,
        InvalidWindow = 1,
        TargetChanged = 2,
        IdentityChanged = 3,
        SelfProcess = 4,
        ModifierDown = 5
    }

    public struct PasteSendResult
    {
        public bool Success;
        public uint Sent;
        public int Error;
    }

    public enum ClipboardBodyState
    {
        Success = 0,
        Changed = 1,
        BodyOnly = 2,
        Failed = 3,
        Ambiguous = 4
    }

    public enum ClipboardOwnershipState
    {
        Owned = 0,
        Changed = 1,
        NotOwned = 2,
        Failed = 3
    }

    public enum ClipboardRestoreState
    {
        Restored = 0,
        Changed = 1,
        NotRestored = 2,
        BodyRetained = 3,
        Ambiguous = 4
    }

    public sealed class NativeClipboardFormat
    {
        public uint Format;
        public byte[] Data;
    }

    public sealed class NativeClipboardSnapshot
    {
        public bool Complete;
        public NativeClipboardFormat[] Formats;
    }

    public sealed class ClipboardBodyResult
    {
        public ClipboardBodyState State;
        public uint Sequence;
        public NativeClipboardSnapshot Snapshot;
    }

    public static class PasteSupport
    {
        private const uint INPUT_KEYBOARD = 1;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint CF_TEXT = 1;
        private const uint CF_BITMAP = 2;
        private const uint CF_OEMTEXT = 7;
        private const uint CF_UNICODETEXT = 13;
        private const uint CF_HDROP = 15;
        private const uint CF_LOCALE = 16;
        private const uint GMEM_MOVEABLE = 0x0002;
        private const uint GMEM_ZEROINIT = 0x0040;
        private const uint WS_POPUP = 0x80000000;
        private const uint PM_REMOVE = 0x0001;
        private const int MAX_CLIPBOARD_FORMATS = 16;
        private const int MAX_CLIPBOARD_FORMAT_BYTES = 16 * 1024 * 1024;
        private const int MAX_CLIPBOARD_TOTAL_BYTES = 32 * 1024 * 1024;
        private const string HTML_FORMAT = "HTML Format";
        private const string RTF_FORMAT = "Rich Text Format";
        private const string MARKER_FORMAT = "Koekaki.Paste.Owner.v1";
        private const ushort VK_CONTROL = 0x11;
        private const ushort VK_SHIFT = 0x10;
        private const ushort VK_MENU = 0x12;
        private const ushort VK_LWIN = 0x5B;
        private const ushort VK_RWIN = 0x5C;
        private const ushort VK_V = 0x56;
        private static IntPtr clipboardOwnerWindow = IntPtr.Zero;

        public static PasteState CheckState(
            long targetHandle,
            uint expectedProcessId,
            uint expectedThreadId,
            uint ownerProcessId
        )
        {
            IntPtr target = new IntPtr(targetHandle);
            if (targetHandle <= 0 || !IsWindow(target)) return PasteState.InvalidWindow;
            if (GetForegroundWindow() != target) return PasteState.TargetChanged;

            uint processId;
            uint threadId = GetWindowThreadProcessId(target, out processId);
            if (
                processId == 0 ||
                threadId == 0 ||
                processId != expectedProcessId ||
                threadId != expectedThreadId
            ) return PasteState.IdentityChanged;

            uint thisProcessId = unchecked((uint)Process.GetCurrentProcess().Id);
            if (processId == thisProcessId || (ownerProcessId != 0 && processId == ownerProcessId))
            {
                return PasteState.SelfProcess;
            }
            if (ModifiersDown()) return PasteState.ModifierDown;
            return PasteState.Ready;
        }

        public static uint ClipboardSequence()
        {
            return GetClipboardSequenceNumber();
        }

        public static ClipboardBodyResult SetBodyAtomic(
            string body,
            string marker,
            uint expectedSequence,
            bool captureSnapshot
        )
        {
            ClipboardBodyResult result = new ClipboardBodyResult();
            result.State = ClipboardBodyState.Failed;
            result.Snapshot = IncompleteSnapshot();
            if (
                expectedSequence == 0 ||
                String.IsNullOrEmpty(body) ||
                String.IsNullOrEmpty(marker) ||
                body.IndexOf('\0') >= 0 ||
                marker.IndexOf('\0') >= 0
            ) return result;

            IntPtr owner = EnsureClipboardOwnerWindow();
            uint markerFormat = RegisterClipboardFormat(MARKER_FORMAT);
            uint htmlFormat = RegisterClipboardFormat(HTML_FORMAT);
            uint rtfFormat = RegisterClipboardFormat(RTF_FORMAT);
            if (owner == IntPtr.Zero || markerFormat == 0 || htmlFormat == 0 || rtfFormat == 0)
            {
                return result;
            }

            byte[] bodyBytes = UnicodeBytes(body);
            byte[] markerBytes = UnicodeBytes(marker);
            IntPtr bodyHandle = AllocateBytes(bodyBytes);
            IntPtr markerHandle = AllocateBytes(markerBytes);
            IntPtr fallbackBodyHandle = AllocateBytes(bodyBytes);
            IntPtr[] rollbackSnapshotHandles = null;
            if (
                bodyHandle == IntPtr.Zero ||
                markerHandle == IntPtr.Zero ||
                fallbackBodyHandle == IntPtr.Zero
            )
            {
                FreeHandle(ref bodyHandle);
                FreeHandle(ref markerHandle);
                FreeHandle(ref fallbackBodyHandle);
                return result;
            }

            bool opened = false;
            try
            {
                opened = TryOpenClipboard(owner);
                if (!opened) return result;
                uint sourceSequence = GetClipboardSequenceNumber();
                if (sourceSequence != expectedSequence)
                {
                    result.State = ClipboardBodyState.Changed;
                    return result;
                }
                IntPtr sourceOwner = GetClipboardOwner();

                NativeClipboardSnapshot rollbackSnapshot = CaptureSnapshotLocked(htmlFormat, rtfFormat);
                if (captureSnapshot) result.Snapshot = rollbackSnapshot;
                rollbackSnapshotHandles = AllocateSnapshotHandles(
                    rollbackSnapshot,
                    htmlFormat,
                    rtfFormat
                );
                uint sequenceAfterCapture = GetClipboardSequenceNumber();
                if (sequenceAfterCapture == 0 || GetClipboardOwner() != sourceOwner)
                {
                    result.State = ClipboardBodyState.Changed;
                    return result;
                }
                if (!EmptyClipboard()) return result;

                if (!TransferClipboardHandle(CF_UNICODETEXT, ref bodyHandle))
                {
                    if (TransferClipboardHandle(CF_UNICODETEXT, ref fallbackBodyHandle))
                    {
                        result.State = ClipboardBodyState.BodyOnly;
                        result.Sequence = GetClipboardSequenceNumber();
                    }
                    else
                    {
                        result.State = rollbackSnapshotHandles != null &&
                            RestoreSnapshotHandlesLocked(rollbackSnapshot, rollbackSnapshotHandles)
                            ? ClipboardBodyState.Failed
                            : ClipboardBodyState.Ambiguous;
                    }
                    return result;
                }
                if (!TransferClipboardHandle(markerFormat, ref markerHandle))
                {
                    result.State = ClipboardBodyState.BodyOnly;
                    result.Sequence = GetClipboardSequenceNumber();
                    return result;
                }

                result.Sequence = GetClipboardSequenceNumber();
                result.State = result.Sequence != 0 && result.Sequence != sequenceAfterCapture
                    ? ClipboardBodyState.Success
                    : ClipboardBodyState.Ambiguous;
                return result;
            }
            finally
            {
                if (opened) CloseClipboard();
                FreeHandle(ref bodyHandle);
                FreeHandle(ref markerHandle);
                FreeHandle(ref fallbackBodyHandle);
                FreeHandles(rollbackSnapshotHandles);
            }
        }

        public static ClipboardOwnershipState CheckBodyAtomic(
            uint expectedSequence,
            string body,
            string marker
        )
        {
            if (expectedSequence == 0 || String.IsNullOrEmpty(body) || String.IsNullOrEmpty(marker))
            {
                return ClipboardOwnershipState.Failed;
            }
            IntPtr owner = EnsureClipboardOwnerWindow();
            uint markerFormat = RegisterClipboardFormat(MARKER_FORMAT);
            if (owner == IntPtr.Zero || markerFormat == 0) return ClipboardOwnershipState.Failed;

            bool opened = false;
            try
            {
                opened = TryOpenClipboard(owner);
                if (!opened) return ClipboardOwnershipState.Failed;
                if (GetClipboardSequenceNumber() != expectedSequence)
                {
                    return ClipboardOwnershipState.Changed;
                }
                if (GetClipboardOwner() != owner) return ClipboardOwnershipState.NotOwned;
                if (!ClipboardBytesEqual(markerFormat, UnicodeBytes(marker)))
                {
                    return ClipboardOwnershipState.NotOwned;
                }
                if (!ClipboardBytesEqual(CF_UNICODETEXT, UnicodeBytes(body)))
                {
                    return ClipboardOwnershipState.NotOwned;
                }
                return GetClipboardSequenceNumber() == expectedSequence
                    ? ClipboardOwnershipState.Owned
                    : ClipboardOwnershipState.Changed;
            }
            finally
            {
                if (opened) CloseClipboard();
            }
        }

        public static ClipboardRestoreState RestoreSnapshotAtomic(
            NativeClipboardSnapshot snapshot,
            uint expectedSequence,
            string body,
            string marker
        )
        {
            if (snapshot == null || !snapshot.Complete)
            {
                return ClipboardRestoreState.NotRestored;
            }
            if (expectedSequence == 0 || String.IsNullOrEmpty(body) || String.IsNullOrEmpty(marker))
            {
                return ClipboardRestoreState.NotRestored;
            }

            IntPtr owner = EnsureClipboardOwnerWindow();
            uint markerFormat = RegisterClipboardFormat(MARKER_FORMAT);
            uint htmlFormat = RegisterClipboardFormat(HTML_FORMAT);
            uint rtfFormat = RegisterClipboardFormat(RTF_FORMAT);
            if (owner == IntPtr.Zero || markerFormat == 0 || htmlFormat == 0 || rtfFormat == 0)
            {
                return ClipboardRestoreState.NotRestored;
            }

            NativeClipboardFormat[] formats = snapshot.Formats ?? new NativeClipboardFormat[0];
            if (formats.Length > MAX_CLIPBOARD_FORMATS) return ClipboardRestoreState.NotRestored;
            IntPtr[] restoreHandles = new IntPtr[formats.Length];
            IntPtr rollbackBody = IntPtr.Zero;
            IntPtr rollbackMarker = IntPtr.Zero;
            int totalBytes = 0;
            try
            {
                for (int index = 0; index < formats.Length; index++)
                {
                    NativeClipboardFormat item = formats[index];
                    if (
                        item == null ||
                        item.Data == null ||
                        !IsRestorableHGlobalFormat(item.Format, htmlFormat, rtfFormat) ||
                        !FormatBytesValid(item.Format, item.Data)
                    ) return ClipboardRestoreState.NotRestored;
                    totalBytes = checked(totalBytes + item.Data.Length);
                    if (totalBytes > MAX_CLIPBOARD_TOTAL_BYTES)
                    {
                        return ClipboardRestoreState.NotRestored;
                    }
                    restoreHandles[index] = AllocateBytes(item.Data);
                    if (restoreHandles[index] == IntPtr.Zero)
                    {
                        return ClipboardRestoreState.NotRestored;
                    }
                }
                rollbackBody = AllocateBytes(UnicodeBytes(body));
                rollbackMarker = AllocateBytes(UnicodeBytes(marker));
                if (rollbackBody == IntPtr.Zero || rollbackMarker == IntPtr.Zero)
                {
                    return ClipboardRestoreState.NotRestored;
                }

                bool opened = false;
                try
                {
                    opened = TryOpenClipboard(owner);
                    if (!opened) return ClipboardRestoreState.NotRestored;
                    if (GetClipboardSequenceNumber() != expectedSequence)
                    {
                        return ClipboardRestoreState.Changed;
                    }
                    if (GetClipboardOwner() != owner) return ClipboardRestoreState.Changed;
                    if (!ClipboardBytesEqual(markerFormat, UnicodeBytes(marker)))
                    {
                        return ClipboardRestoreState.Changed;
                    }
                    if (!ClipboardBytesEqual(CF_UNICODETEXT, UnicodeBytes(body)))
                    {
                        return ClipboardRestoreState.Changed;
                    }
                    if (GetClipboardSequenceNumber() != expectedSequence)
                    {
                        return ClipboardRestoreState.Changed;
                    }
                    if (!EmptyClipboard()) return ClipboardRestoreState.NotRestored;

                    bool restored = true;
                    for (int index = 0; index < formats.Length; index++)
                    {
                        if (!TransferClipboardHandle(formats[index].Format, ref restoreHandles[index]))
                        {
                            restored = false;
                            break;
                        }
                    }
                    if (restored) return ClipboardRestoreState.Restored;

                    if (!EmptyClipboard()) return ClipboardRestoreState.Ambiguous;
                    if (!TransferClipboardHandle(CF_UNICODETEXT, ref rollbackBody))
                    {
                        return ClipboardRestoreState.Ambiguous;
                    }
                    if (!TransferClipboardHandle(markerFormat, ref rollbackMarker))
                    {
                        return ClipboardRestoreState.BodyRetained;
                    }
                    return ClipboardRestoreState.BodyRetained;
                }
                finally
                {
                    if (opened) CloseClipboard();
                }
            }
            catch (OverflowException)
            {
                return ClipboardRestoreState.NotRestored;
            }
            finally
            {
                for (int index = 0; index < restoreHandles.Length; index++)
                {
                    FreeHandle(ref restoreHandles[index]);
                }
                FreeHandle(ref rollbackBody);
                FreeHandle(ref rollbackMarker);
            }
        }

        public static void PumpMessagesFor(int milliseconds)
        {
            if (milliseconds <= 0) return;
            Stopwatch timer = Stopwatch.StartNew();
            while (timer.ElapsedMilliseconds < milliseconds)
            {
                PumpPendingMessages();
                int remaining = milliseconds - (int)timer.ElapsedMilliseconds;
                if (remaining > 0) Thread.Sleep(Math.Min(10, remaining));
            }
        }

        public static PasteSendResult SendPaste()
        {
            INPUT[] inputs = BuildPasteInputs();
            uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            int error = sent == inputs.Length ? 0 : Marshal.GetLastWin32Error();
            if (sent != inputs.Length) ReleasePasteKeys();
            PasteSendResult result = new PasteSendResult();
            result.Success = sent == inputs.Length;
            result.Sent = sent;
            result.Error = error;
            return result;
        }

        public static bool SelfTest()
        {
            int expectedInputSize = IntPtr.Size == 8 ? 40 : 28;
            int expectedKeyInputSize = IntPtr.Size == 8 ? 24 : 16;
            int expectedUnionOffset = IntPtr.Size == 8 ? 8 : 4;
            if (Marshal.SizeOf(typeof(INPUT)) != expectedInputSize) return false;
            if (Marshal.SizeOf(typeof(KEYBDINPUT)) != expectedKeyInputSize) return false;
            if (Marshal.OffsetOf(typeof(INPUT), "U").ToInt32() != expectedUnionOffset) return false;

            INPUT[] inputs = BuildPasteInputs();
            if (inputs.Length != 4) return false;
            if (inputs[0].U.ki.wVk != VK_CONTROL || inputs[0].U.ki.dwFlags != 0) return false;
            if (inputs[1].U.ki.wVk != VK_V || inputs[1].U.ki.dwFlags != 0) return false;
            if (inputs[2].U.ki.wVk != VK_V || inputs[2].U.ki.dwFlags != KEYEVENTF_KEYUP) return false;
            if (inputs[3].U.ki.wVk != VK_CONTROL || inputs[3].U.ki.dwFlags != KEYEVENTF_KEYUP) return false;
            if (EvaluateState(true, 10, 10, 20, 20, false, false) != PasteState.Ready) return false;
            if (EvaluateState(false, 10, 10, 20, 20, false, false) != PasteState.InvalidWindow) return false;
            if (EvaluateState(true, 10, 11, 20, 20, false, false) != PasteState.TargetChanged) return false;
            if (EvaluateState(true, 10, 10, 20, 21, false, false) != PasteState.IdentityChanged) return false;
            if (EvaluateState(true, 10, 10, 20, 20, true, false) != PasteState.SelfProcess) return false;
            if (EvaluateState(true, 10, 10, 20, 20, false, true) != PasteState.ModifierDown) return false;
            uint fakeHtml = 0xC001;
            uint fakeRtf = 0xC002;
            if (!IsRestorableHGlobalFormat(CF_UNICODETEXT, fakeHtml, fakeRtf)) return false;
            if (!IsRestorableHGlobalFormat(CF_TEXT, fakeHtml, fakeRtf)) return false;
            if (!IsRestorableHGlobalFormat(CF_OEMTEXT, fakeHtml, fakeRtf)) return false;
            if (!IsRestorableHGlobalFormat(CF_HDROP, fakeHtml, fakeRtf)) return false;
            if (!IsRestorableHGlobalFormat(CF_LOCALE, fakeHtml, fakeRtf)) return false;
            if (!IsRestorableHGlobalFormat(fakeHtml, fakeHtml, fakeRtf)) return false;
            if (!IsRestorableHGlobalFormat(fakeRtf, fakeHtml, fakeRtf)) return false;
            if (IsRestorableHGlobalFormat(CF_BITMAP, fakeHtml, fakeRtf)) return false;
            if (IsRestorableHGlobalFormat(0xC003, fakeHtml, fakeRtf)) return false;
            byte[] unicode = UnicodeBytes("A");
            if (unicode.Length != 4 || unicode[0] != 65 || unicode[1] != 0) return false;
            if (unicode[2] != 0 || unicode[3] != 0) return false;
            byte[] paddedUnicode = new byte[] { 65, 0, 0, 0, 0, 0 };
            if (!BytesMatchWithZeroPadding(paddedUnicode, unicode)) return false;
            paddedUnicode[5] = 1;
            if (BytesMatchWithZeroPadding(paddedUnicode, unicode)) return false;
            byte[] changedUnicode = new byte[] { 66, 0, 0, 0 };
            if (BytesMatchWithZeroPadding(changedUnicode, unicode)) return false;
            if (!FormatBytesValid(CF_OEMTEXT, new byte[] { 65, 0 })) return false;
            if (FormatBytesValid(CF_OEMTEXT, new byte[] { 65 })) return false;
            byte[] locale = new byte[] { 0x09, 0x04, 0, 0, 0, 0, 0, 0 };
            if (!FormatBytesValid(CF_LOCALE, locale)) return false;
            locale[7] = 1;
            if (!FormatBytesValid(CF_LOCALE, locale)) return false;
            if (FormatBytesValid(CF_LOCALE, new byte[3])) return false;
            if (FormatBytesValid(CF_LOCALE, new byte[17])) return false;
            byte[] hdrop = new byte[24];
            Buffer.BlockCopy(BitConverter.GetBytes((uint)20), 0, hdrop, 0, 4);
            Buffer.BlockCopy(BitConverter.GetBytes(1), 0, hdrop, 16, 4);
            if (!HDropBytesValid(hdrop)) return false;
            hdrop[0] = 19;
            if (HDropBytesValid(hdrop)) return false;
            return true;
        }

        private static PasteState EvaluateState(
            bool validWindow,
            long foreground,
            long target,
            uint processId,
            uint expectedProcessId,
            bool selfProcess,
            bool modifierDown
        )
        {
            if (!validWindow) return PasteState.InvalidWindow;
            if (foreground != target) return PasteState.TargetChanged;
            if (processId != expectedProcessId) return PasteState.IdentityChanged;
            if (selfProcess) return PasteState.SelfProcess;
            if (modifierDown) return PasteState.ModifierDown;
            return PasteState.Ready;
        }

        private static NativeClipboardSnapshot IncompleteSnapshot()
        {
            NativeClipboardSnapshot snapshot = new NativeClipboardSnapshot();
            snapshot.Complete = false;
            snapshot.Formats = new NativeClipboardFormat[0];
            return snapshot;
        }

        private static NativeClipboardSnapshot CaptureSnapshotLocked(
            uint htmlFormat,
            uint rtfFormat
        )
        {
            NativeClipboardSnapshot incomplete = IncompleteSnapshot();
            List<NativeClipboardFormat> formats = new List<NativeClipboardFormat>();
            int totalBytes = 0;
            uint previous = 0;
            while (true)
            {
                SetLastErrorNative(0);
                uint format = EnumClipboardFormats(previous);
                if (format == 0)
                {
                    if (Marshal.GetLastWin32Error() != 0) return incomplete;
                    break;
                }
                previous = format;
                if (
                    formats.Count >= MAX_CLIPBOARD_FORMATS ||
                    !IsRestorableHGlobalFormat(format, htmlFormat, rtfFormat)
                ) return incomplete;

                byte[] data = CopyClipboardBytes(format);
                if (data == null || !FormatBytesValid(format, data)) return incomplete;
                try
                {
                    totalBytes = checked(totalBytes + data.Length);
                }
                catch (OverflowException)
                {
                    return incomplete;
                }
                if (totalBytes > MAX_CLIPBOARD_TOTAL_BYTES) return incomplete;
                NativeClipboardFormat item = new NativeClipboardFormat();
                item.Format = format;
                item.Data = data;
                formats.Add(item);
            }

            NativeClipboardSnapshot snapshot = new NativeClipboardSnapshot();
            snapshot.Complete = true;
            snapshot.Formats = formats.ToArray();
            return snapshot;
        }

        private static IntPtr[] AllocateSnapshotHandles(
            NativeClipboardSnapshot snapshot,
            uint htmlFormat,
            uint rtfFormat
        )
        {
            if (snapshot == null || !snapshot.Complete) return null;
            NativeClipboardFormat[] formats = snapshot.Formats ?? new NativeClipboardFormat[0];
            if (formats.Length > MAX_CLIPBOARD_FORMATS) return null;
            IntPtr[] handles = new IntPtr[formats.Length];
            int totalBytes = 0;
            try
            {
                for (int index = 0; index < formats.Length; index++)
                {
                    NativeClipboardFormat item = formats[index];
                    if (
                        item == null ||
                        item.Data == null ||
                        !IsRestorableHGlobalFormat(item.Format, htmlFormat, rtfFormat) ||
                        !FormatBytesValid(item.Format, item.Data)
                    )
                    {
                        FreeHandles(handles);
                        return null;
                    }
                    totalBytes = checked(totalBytes + item.Data.Length);
                    if (totalBytes > MAX_CLIPBOARD_TOTAL_BYTES)
                    {
                        FreeHandles(handles);
                        return null;
                    }
                    handles[index] = AllocateBytes(item.Data);
                    if (handles[index] == IntPtr.Zero)
                    {
                        FreeHandles(handles);
                        return null;
                    }
                }
                return handles;
            }
            catch (OverflowException)
            {
                FreeHandles(handles);
                return null;
            }
        }

        private static bool RestoreSnapshotHandlesLocked(
            NativeClipboardSnapshot snapshot,
            IntPtr[] handles
        )
        {
            if (snapshot == null || !snapshot.Complete || handles == null) return false;
            NativeClipboardFormat[] formats = snapshot.Formats ?? new NativeClipboardFormat[0];
            if (formats.Length != handles.Length || !EmptyClipboard()) return false;
            for (int index = 0; index < formats.Length; index++)
            {
                if (!TransferClipboardHandle(formats[index].Format, ref handles[index])) return false;
            }
            return true;
        }

        private static bool IsRestorableHGlobalFormat(uint format, uint htmlFormat, uint rtfFormat)
        {
            return format == CF_UNICODETEXT ||
                format == CF_TEXT ||
                format == CF_OEMTEXT ||
                format == CF_HDROP ||
                format == CF_LOCALE ||
                format == htmlFormat ||
                format == rtfFormat;
        }

        private static bool FormatBytesValid(uint format, byte[] data)
        {
            if (
                data == null ||
                data.Length == 0 ||
                data.Length > MAX_CLIPBOARD_FORMAT_BYTES
            ) return false;
            if (format == CF_UNICODETEXT)
            {
                return data.Length >= 2 &&
                    data.Length % 2 == 0 &&
                    data[data.Length - 1] == 0 &&
                    data[data.Length - 2] == 0;
            }
            if (format == CF_TEXT || format == CF_OEMTEXT)
            {
                return data[data.Length - 1] == 0;
            }
            if (format == CF_LOCALE)
            {
                return data.Length >= 4 && data.Length <= 16;
            }
            if (format == CF_HDROP) return HDropBytesValid(data);
            return true;
        }

        private static bool HDropBytesValid(byte[] data)
        {
            if (data.Length < 22) return false;
            uint offset = BitConverter.ToUInt32(data, 0);
            int wide = BitConverter.ToInt32(data, 16);
            if (offset < 20 || offset >= data.Length || (wide != 0 && wide != 1)) return false;
            int remaining = data.Length - checked((int)offset);
            if (wide == 1)
            {
                return remaining >= 4 &&
                    remaining % 2 == 0 &&
                    data[data.Length - 1] == 0 &&
                    data[data.Length - 2] == 0 &&
                    data[data.Length - 3] == 0 &&
                    data[data.Length - 4] == 0;
            }
            return remaining >= 2 && data[data.Length - 1] == 0 && data[data.Length - 2] == 0;
        }

        private static byte[] UnicodeBytes(string value)
        {
            return Encoding.Unicode.GetBytes(value + "\0");
        }

        private static byte[] CopyClipboardBytes(uint format)
        {
            IntPtr handle = GetClipboardData(format);
            if (handle == IntPtr.Zero) return null;
            ulong rawSize = GlobalSize(handle).ToUInt64();
            if (rawSize == 0 || rawSize > MAX_CLIPBOARD_FORMAT_BYTES) return null;
            int size = checked((int)rawSize);
            IntPtr pointer = GlobalLock(handle);
            if (pointer == IntPtr.Zero) return null;
            try
            {
                byte[] data = new byte[size];
                Marshal.Copy(pointer, data, 0, size);
                return data;
            }
            finally
            {
                GlobalUnlock(handle);
            }
        }

        private static bool ClipboardBytesEqual(uint format, byte[] expected)
        {
            byte[] actual = CopyClipboardBytes(format);
            return BytesMatchWithZeroPadding(actual, expected);
        }

        private static bool BytesMatchWithZeroPadding(byte[] actual, byte[] expected)
        {
            if (actual == null || expected == null || actual.Length < expected.Length) return false;
            for (int index = 0; index < expected.Length; index++)
            {
                if (actual[index] != expected[index]) return false;
            }
            for (int index = expected.Length; index < actual.Length; index++)
            {
                if (actual[index] != 0) return false;
            }
            return true;
        }

        private static IntPtr AllocateBytes(byte[] data)
        {
            if (
                data == null ||
                data.Length == 0 ||
                data.Length > MAX_CLIPBOARD_FORMAT_BYTES
            ) return IntPtr.Zero;
            IntPtr handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, new UIntPtr((uint)data.Length));
            if (handle == IntPtr.Zero) return IntPtr.Zero;
            IntPtr pointer = GlobalLock(handle);
            if (pointer == IntPtr.Zero)
            {
                GlobalFree(handle);
                return IntPtr.Zero;
            }
            try
            {
                Marshal.Copy(data, 0, pointer, data.Length);
            }
            finally
            {
                GlobalUnlock(handle);
            }
            return handle;
        }

        private static void FreeHandle(ref IntPtr handle)
        {
            if (handle == IntPtr.Zero) return;
            GlobalFree(handle);
            handle = IntPtr.Zero;
        }

        private static void FreeHandles(IntPtr[] handles)
        {
            if (handles == null) return;
            for (int index = 0; index < handles.Length; index++)
            {
                FreeHandle(ref handles[index]);
            }
        }

        private static bool TransferClipboardHandle(uint format, ref IntPtr handle)
        {
            if (handle == IntPtr.Zero) return false;
            if (SetClipboardData(format, handle) == IntPtr.Zero) return false;
            handle = IntPtr.Zero;
            return true;
        }

        private static IntPtr EnsureClipboardOwnerWindow()
        {
            if (clipboardOwnerWindow != IntPtr.Zero && IsWindow(clipboardOwnerWindow))
            {
                return clipboardOwnerWindow;
            }
            clipboardOwnerWindow = CreateWindowEx(
                0,
                "STATIC",
                "KoekakiClipboardOwner",
                WS_POPUP,
                0,
                0,
                0,
                0,
                IntPtr.Zero,
                IntPtr.Zero,
                IntPtr.Zero,
                IntPtr.Zero
            );
            return clipboardOwnerWindow;
        }

        private static bool TryOpenClipboard(IntPtr owner)
        {
            for (int attempt = 0; attempt < 5; attempt++)
            {
                if (OpenClipboard(owner)) return true;
                PumpPendingMessages();
                Thread.Sleep(20);
            }
            return false;
        }

        private static void PumpPendingMessages()
        {
            MSG message;
            while (PeekMessage(out message, IntPtr.Zero, 0, 0, PM_REMOVE))
            {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
        }

        private static INPUT[] BuildPasteInputs()
        {
            INPUT[] inputs = new INPUT[4];
            inputs[0] = KeyboardInput(VK_CONTROL, 0);
            inputs[1] = KeyboardInput(VK_V, 0);
            inputs[2] = KeyboardInput(VK_V, KEYEVENTF_KEYUP);
            inputs[3] = KeyboardInput(VK_CONTROL, KEYEVENTF_KEYUP);
            return inputs;
        }

        private static INPUT KeyboardInput(ushort key, uint flags)
        {
            INPUT input = new INPUT();
            input.type = INPUT_KEYBOARD;
            input.U.ki.wVk = key;
            input.U.ki.dwFlags = flags;
            return input;
        }

        private static void ReleasePasteKeys()
        {
            INPUT[] releases = new INPUT[2];
            releases[0] = KeyboardInput(VK_V, KEYEVENTF_KEYUP);
            releases[1] = KeyboardInput(VK_CONTROL, KEYEVENTF_KEYUP);
            SendInput((uint)releases.Length, releases, Marshal.SizeOf(typeof(INPUT)));
        }

        private static bool ModifiersDown()
        {
            return IsKeyDown(VK_CONTROL) ||
                IsKeyDown(VK_SHIFT) ||
                IsKeyDown(VK_MENU) ||
                IsKeyDown(VK_LWIN) ||
                IsKeyDown(VK_RWIN);
        }

        private static bool IsKeyDown(int key)
        {
            return (((ushort)GetAsyncKeyState(key)) & 0x8000) != 0;
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
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
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

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
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

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetClipboardSequenceNumber();

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateWindowEx(
            uint extendedStyle,
            string className,
            string windowName,
            uint style,
            int x,
            int y,
            int width,
            int height,
            IntPtr parent,
            IntPtr menu,
            IntPtr instance,
            IntPtr parameter
        );

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool OpenClipboard(IntPtr owner);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseClipboard();

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EmptyClipboard();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr GetClipboardData(uint format);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetClipboardData(uint format, IntPtr memory);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint EnumClipboardFormats(uint format);

        [DllImport("user32.dll")]
        private static extern IntPtr GetClipboardOwner();

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint RegisterClipboardFormat(string format);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PeekMessage(
            out MSG message,
            IntPtr window,
            uint filterMin,
            uint filterMax,
            uint remove
        );

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TranslateMessage(ref MSG message);

        [DllImport("user32.dll")]
        private static extern IntPtr DispatchMessage(ref MSG message);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GlobalLock(IntPtr memory);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GlobalUnlock(IntPtr memory);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern UIntPtr GlobalSize(IntPtr memory);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GlobalFree(IntPtr memory);

        [DllImport("kernel32.dll", EntryPoint = "SetLastError")]
        private static extern void SetLastErrorNative(uint error);
    }
}
'@

function Write-PasteStatus([string]$Status) {
    [Console]::Out.WriteLine($Status)
    [Console]::Out.Flush()
}

function Get-PasteStateStatus($State) {
    switch ($State.ToString()) {
        'InvalidWindow' { return 'PASTE_SKIPPED_INVALID_WINDOW' }
        'TargetChanged' { return 'PASTE_SKIPPED_TARGET' }
        'IdentityChanged' { return 'PASTE_SKIPPED_IDENTITY' }
        'SelfProcess' { return 'PASTE_SKIPPED_SELF' }
        'ModifierDown' { return 'PASTE_SKIPPED_MODIFIER' }
        default { return 'PASTE_STATE_FAILED' }
    }
}

function Set-ClipboardBody(
    [string]$Body,
    [string]$Marker,
    [uint32]$ExpectedSequence,
    [bool]$CaptureSnapshot
) {
    return [Koekaki.Desktop.PasteSupport]::SetBodyAtomic(
        $Body,
        $Marker,
        $ExpectedSequence,
        $CaptureSnapshot
    )
}

function Get-ClipboardBodyOwnership(
    [uint32]$ExpectedSequence,
    [string]$Body,
    [string]$Marker
) {
    return [Koekaki.Desktop.PasteSupport]::CheckBodyAtomic(
        $ExpectedSequence,
        $Body,
        $Marker
    )
}

function Restore-ClipboardSnapshot(
    $Snapshot,
    [uint32]$ExpectedSequence,
    [string]$Body,
    [string]$Marker
) {
    return [Koekaki.Desktop.PasteSupport]::RestoreSnapshotAtomic(
        $Snapshot,
        $ExpectedSequence,
        $Body,
        $Marker
    )
}

$modeCount = [int]$SelfTest.IsPresent + [int]$Paste.IsPresent + [int]$PasteSelfTest.IsPresent
if ($modeCount -gt 1) {
    [Console]::Error.WriteLine('MODE_CONFLICT')
    exit 1
}

try {
    Add-Type -TypeDefinition $source -Language CSharp

    if ($PasteSelfTest.IsPresent) {
        if ([Koekaki.Desktop.PasteSupport]::SelfTest()) {
            Write-PasteStatus 'PASTE_SELF_TEST_OK'
            exit 0
        }
        [Console]::Error.WriteLine('PASTE_SELF_TEST_FAILED')
        exit 1
    }

    if ($Paste.IsPresent) {
        if ([Threading.Thread]::CurrentThread.GetApartmentState().ToString() -ne 'STA') {
            [Console]::Error.WriteLine('PASTE_STA_REQUIRED')
            exit 1
        }

        $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
        $standardInput = [Console]::OpenStandardInput()
        $reader = [System.IO.StreamReader]::new($standardInput, $strictUtf8, $false, 4096, $false)
        $builder = New-Object System.Text.StringBuilder
        $readBuffer = New-Object char[] 4096
        $totalChars = 0
        try {
            while (($readCount = $reader.Read($readBuffer, 0, $readBuffer.Length)) -gt 0) {
                $totalChars += $readCount
                if ($totalChars -gt 1000000) { throw 'input too large' }
                [void]$builder.Append($readBuffer, 0, $readCount)
            }
        }
        finally {
            $reader.Dispose()
        }
        $body = $builder.ToString()
        $bodyBytes = $strictUtf8.GetByteCount($body)
        if (
            [string]::IsNullOrEmpty($body) -or
            $body.IndexOf([char]0) -ge 0 -or
            $bodyBytes -gt 4000000
        ) {
            [Console]::Error.WriteLine('PASTE_INPUT_INVALID')
            exit 1
        }

        $marker = [Guid]::NewGuid().ToString('N')
        $sequenceBeforeState = [Koekaki.Desktop.PasteSupport]::ClipboardSequence()
        if ($sequenceBeforeState -eq 0) {
            Write-PasteStatus 'PASTE_CLIPBOARD_FAILED'
            exit 4
        }

        $state = [Koekaki.Desktop.PasteSupport]::CheckState(
            $TargetHandle,
            $TargetProcessId,
            $TargetThreadId,
            $OwnerProcessId
        )
        if ($state.ToString() -ne 'Ready') {
            $fallbackResult = Set-ClipboardBody $body $marker $sequenceBeforeState $false
            switch ($fallbackResult.State.ToString()) {
                'Changed' {
                    Write-PasteStatus 'PASTE_SKIPPED_CLIPBOARD_CHANGED'
                    exit 5
                }
                'Success' {
                    Write-PasteStatus (Get-PasteStateStatus $state)
                    exit 2
                }
                'BodyOnly' {
                    Write-PasteStatus (Get-PasteStateStatus $state)
                    exit 2
                }
                'Failed' {
                    Write-PasteStatus 'PASTE_CLIPBOARD_FAILED'
                    exit 4
                }
                default { throw 'atomic clipboard fallback failed' }
            }
        }

        $sequenceBefore = [Koekaki.Desktop.PasteSupport]::ClipboardSequence()
        if ($sequenceBefore -eq 0) {
            Write-PasteStatus 'PASTE_CLIPBOARD_FAILED'
            exit 4
        }
        $bodyResult = Set-ClipboardBody $body $marker $sequenceBefore $true
        switch ($bodyResult.State.ToString()) {
            'Changed' {
                Write-PasteStatus 'PASTE_SKIPPED_CLIPBOARD_CHANGED'
                exit 5
            }
            'BodyOnly' {
                Write-PasteStatus 'PASTE_SEND_FAILED'
                exit 3
            }
            'Failed' {
                Write-PasteStatus 'PASTE_CLIPBOARD_FAILED'
                exit 4
            }
            'Success' { }
            default { throw 'atomic clipboard setup failed' }
        }
        $sequenceBody = [uint32]$bodyResult.Sequence
        $snapshot = $bodyResult.Snapshot

        $state = [Koekaki.Desktop.PasteSupport]::CheckState(
            $TargetHandle,
            $TargetProcessId,
            $TargetThreadId,
            $OwnerProcessId
        )
        if ($state.ToString() -ne 'Ready') {
            $ownership = Get-ClipboardBodyOwnership $sequenceBody $body $marker
            if ($ownership.ToString() -eq 'Owned') {
                Write-PasteStatus (Get-PasteStateStatus $state)
                exit 2
            }
            if ($ownership.ToString() -eq 'Changed') {
                Write-PasteStatus 'PASTE_SKIPPED_CLIPBOARD_CHANGED'
                exit 5
            }
            throw 'clipboard ownership unavailable'
        }
        $ownership = Get-ClipboardBodyOwnership $sequenceBody $body $marker
        if ($ownership.ToString() -eq 'Changed') {
            Write-PasteStatus 'PASTE_SKIPPED_CLIPBOARD_CHANGED'
            exit 5
        }
        if ($ownership.ToString() -ne 'Owned') {
            throw 'clipboard ownership unavailable'
        }

        $state = [Koekaki.Desktop.PasteSupport]::CheckState(
            $TargetHandle,
            $TargetProcessId,
            $TargetThreadId,
            $OwnerProcessId
        )
        if ($state.ToString() -ne 'Ready') {
            $ownership = Get-ClipboardBodyOwnership $sequenceBody $body $marker
            if ($ownership.ToString() -eq 'Changed') {
                Write-PasteStatus 'PASTE_SKIPPED_CLIPBOARD_CHANGED'
                exit 5
            }
            if ($ownership.ToString() -eq 'Owned') {
                Write-PasteStatus (Get-PasteStateStatus $state)
                exit 2
            }
            throw 'clipboard ownership unavailable'
        }

        $sendResult = [Koekaki.Desktop.PasteSupport]::SendPaste()
        if (-not $sendResult.Success) {
            $ownership = Get-ClipboardBodyOwnership $sequenceBody $body $marker
            if ($ownership.ToString() -eq 'Changed') {
                Write-PasteStatus 'PASTE_SKIPPED_CLIPBOARD_CHANGED'
                exit 5
            }
            if ($ownership.ToString() -ne 'Owned') {
                throw 'clipboard ownership unavailable'
            }
            Write-PasteStatus 'PASTE_SEND_FAILED'
            exit 3
        }

        [Koekaki.Desktop.PasteSupport]::PumpMessagesFor(750)
        $restoreState = Restore-ClipboardSnapshot $snapshot $sequenceBody $body $marker
        if ($restoreState.ToString() -eq 'Restored') {
            Write-PasteStatus 'PASTE_OK_RESTORED'
        }
        elseif ($restoreState.ToString() -eq 'Ambiguous') {
            throw 'atomic clipboard restore failed'
        }
        else {
            Write-PasteStatus 'PASTE_OK_NOT_RESTORED'
        }
        exit 0
    }

    $exitCode = [Koekaki.Desktop.RightAltHook]::Run(
        $SelfTest.IsPresent,
        -not $NoSuppress.IsPresent,
        $ParentPid
    )
    exit $exitCode
}
catch {
    if ($Paste.IsPresent) {
        [Console]::Error.WriteLine('PASTE_FATAL')
    }
    else {
        [Console]::Error.WriteLine('HOTKEY_FATAL ' + $_.Exception.Message)
    }
    exit 1
}
