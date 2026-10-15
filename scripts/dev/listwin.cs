// 诊断：列出所有可见顶层窗口及其所属进程，用于定位桌宠窗口到底归哪个进程。
// 编译：csc /nologo /out:listwin.exe listwin.cs
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

internal static class ListWin
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT p);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    private static int Main(string[] args)
    {
        // 子命令：
        //   move <x> <y>   移动真实光标并回读实际位置
        //   cursor         读取当前光标位置
        // 做成已编译的小工具，是因为用 PowerShell + Add-Type 每次要编译一两秒，
        // 会让"移动光标"与随后的断言之间产生竞态（实测就是这样误判的）。
        if (args.Length >= 3 && args[0] == "move")
        {
            try { SetProcessDPIAware(); } catch { }
            SetCursorPos(int.Parse(args[1]), int.Parse(args[2]));
            POINT p;
            GetCursorPos(out p);
            Console.WriteLine(p.X + "," + p.Y);
            return 0;
        }
        if (args.Length >= 1 && args[0] == "cursor")
        {
            try { SetProcessDPIAware(); } catch { }
            POINT p;
            GetCursorPos(out p);
            Console.WriteLine(p.X + "," + p.Y);
            return 0;
        }

        string filter = args.Length > 0 ? args[0].ToLowerInvariant() : null;

        var procNames = new Dictionary<uint, string>();
        foreach (var p in Process.GetProcesses())
        {
            try { procNames[(uint)p.Id] = p.ProcessName; }
            catch { }
        }

        int total = 0;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            string name = procNames.ContainsKey(pid) ? procNames[pid] : "?";

            if (filter != null && name.ToLowerInvariant().IndexOf(filter, StringComparison.Ordinal) < 0)
                return true;

            bool visible = IsWindowVisible(hWnd);
            RECT r;
            GetWindowRect(hWnd, out r);
            var cls = new StringBuilder(256);
            GetClassName(hWnd, cls, 256);
            var title = new StringBuilder(256);
            GetWindowText(hWnd, title, 256);

            total++;
            Console.WriteLine(string.Format(
                "pid={0,-7} proc={1,-22} visible={2,-5} {3,5}x{4,-5} @ ({5},{6})  class={7}  title={8}",
                pid, name, visible, r.Right - r.Left, r.Bottom - r.Top, r.Left, r.Top,
                cls.ToString(), title.ToString()));
            return true;
        }, IntPtr.Zero);

        Console.WriteLine("共 " + total + " 个窗口" + (filter != null ? "（已按进程名过滤: " + filter + "）" : ""));
        return 0;
    }
}
