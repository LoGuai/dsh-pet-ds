// 诊断工具：把某个窗口强制改成指定尺寸，用来验证桌宠的"尺寸看门狗"是否生效。
// 用法：resizewin.exe <标题片段> <宽> <高>
// 编译：csc /nologo /out:resizewin.exe resizewin.cs
using System;
using System.Runtime.InteropServices;
using System.Text;

internal static class ResizeWin
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;

    private static IntPtr found = IntPtr.Zero;
    private static string needle = "";

    private static bool Callback(IntPtr hWnd, IntPtr lParam)
    {
        if (!IsWindowVisible(hWnd)) return true;
        var sb = new StringBuilder(512);
        GetWindowText(hWnd, sb, sb.Capacity);
        string t = sb.ToString();
        if (t.Length > 0 && t.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)
        {
            // 只认真正的大窗口：Electron 会同时存在多个同标题的辅助窗口
            // （隐藏的 Chrome_WidgetWin_0 等），必须按**尺寸**把它们排除，
            // 否则会改错对象 —— 这个坑让一次诊断白跑。
            RECT r;
            GetWindowRect(hWnd, out r);
            if ((r.Right - r.Left) >= 100 && (r.Bottom - r.Top) >= 100)
            {
                found = hWnd;
                return false;
            }
        }
        return true;
    }

    private static int Main(string[] args)
    {
        try { SetProcessDPIAware(); } catch { }
        if (args.Length < 3)
        {
            Console.WriteLine("用法: resizewin.exe <标题片段> <宽> <高> [x] [y]");
            return 2;
        }
        needle = args[0];
        int w = int.Parse(args[1]);
        int h = int.Parse(args[2]);

        EnumWindows(Callback, IntPtr.Zero);
        if (found == IntPtr.Zero)
        {
            Console.WriteLine("未找到标题含 \"" + needle + "\" 的可见窗口");
            return 1;
        }

        RECT r;
        GetWindowRect(found, out r);
        Console.WriteLine("改前: " + (r.Right - r.Left) + "x" + (r.Bottom - r.Top) + " @ (" + r.Left + "," + r.Top + ")");
        int x = args.Length >= 5 ? int.Parse(args[3]) : r.Left;
        int y = args.Length >= 5 ? int.Parse(args[4]) : r.Top;

        SetWindowPos(found, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
        GetWindowRect(found, out r);
        Console.WriteLine("改为: " + (r.Right - r.Left) + "x" + (r.Bottom - r.Top) + " @ (" + r.Left + "," + r.Top + ")");
        return 0;
    }
}
