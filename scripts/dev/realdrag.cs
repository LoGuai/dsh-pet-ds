// 用**真实的系统鼠标输入**（SendInput）拖动桌宠窗口，并测量拖拽前后的窗口几何。
//
// 为什么需要它：合成 MouseEvent 的 screenX/screenY 与鼠标真实位置不一致
// （鼠标物理上并不在那些坐标上），无法用来断言位移与尺寸。
// SendInput 走的是与真人操作完全相同的路径，因此这是唯一有说服力的验证方式。
//
// 编译：csc /nologo /out:realdrag.exe realdrag.cs
// 用法：realdrag.exe <窗口标题关键字> <水平位移> <垂直位移> <步数>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class RealDrag
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);

    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }

    private const uint LEFTDOWN = 0x0002;
    private const uint LEFTUP = 0x0004;

    private static int Main(string[] args)
    {
        try { SetProcessDPIAware(); } catch { }

        string title = args.Length > 0 ? args[0] : "DSH Pet";
        int dx = args.Length > 1 ? int.Parse(args[1]) : 120;
        int dy = args.Length > 2 ? int.Parse(args[2]) : -100;
        int steps = args.Length > 3 ? int.Parse(args[3]) : 30;

        IntPtr target = IntPtr.Zero;
        RECT rect = new RECT();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(hWnd, sb, 512);
            if (sb.ToString().IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) return true;
            var r = new RECT();
            if (!GetWindowRect(hWnd, out r)) return true;
            // 取面积最大的那个（同名窗口可能有隐藏的小窗）
            if ((long)(r.Right - r.Left) * (r.Bottom - r.Top) > (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top))
            {
                target = hWnd;
                rect = r;
            }
            return true;
        }, IntPtr.Zero);

        if (target == IntPtr.Zero)
        {
            Console.Error.WriteLine("找不到标题含 \"" + title + "\" 的可见窗口");
            return 2;
        }

        int w0 = rect.Right - rect.Left;
        int h0 = rect.Bottom - rect.Top;
        Console.WriteLine(string.Format("拖拽前: {0}x{1} @ ({2},{3})", w0, h0, rect.Left, rect.Top));

        // 抓在窗口中心（宠物身体上）。
        int startX = rect.Left + w0 / 2;
        int startY = rect.Top + h0 / 2;
        SetForegroundWindow(target);
        Thread.Sleep(300);
        SetCursorPos(startX, startY);
        Thread.Sleep(200);
        mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        Thread.Sleep(120);   // 超过 180ms 的拎起阈值需要更久，这里先确保拖动成立

        // 分成多步移动，模拟真人连续鼠标。
        for (int i = 1; i <= steps; i++)
        {
            int x = startX + (int)Math.Round((double)dx * i / steps);
            int y = startY + (int)Math.Round((double)dy * i / steps);
            SetCursorPos(x, y);
            Thread.Sleep(16);
        }

        Thread.Sleep(150);
        RECT during = new RECT();
        GetWindowRect(target, out during);
        Console.WriteLine(string.Format("拖拽中: {0}x{1} @ ({2},{3})",
            during.Right - during.Left, during.Bottom - during.Top, during.Left, during.Top));

        mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
        Thread.Sleep(600);

        RECT after = new RECT();
        GetWindowRect(target, out after);
        int w1 = after.Right - after.Left;
        int h1 = after.Bottom - after.Top;
        Console.WriteLine(string.Format("拖拽后: {0}x{1} @ ({2},{3})", w1, h1, after.Left, after.Top));

        int mx = after.Left - rect.Left;
        int my = after.Top - rect.Top;
        Console.WriteLine(string.Format("尺寸变化: {0}x{1}   位移: ({2},{3})", w1 - w0, h1 - h0, mx, my));
        Console.WriteLine(string.Format("位移与鼠标位移是否一致: {0} (期望 {1},{2}，容差 12)",
            (Math.Abs(mx - dx) <= 12 && Math.Abs(my - dy) <= 12) ? "PASS" : "FAIL", dx, dy));
        Console.WriteLine(string.Format("尺寸是否稳定: {0} (容差 2px)",
            (Math.Abs(w1 - w0) <= 2 && Math.Abs(h1 - h0) <= 2) ? "PASS" : "FAIL"));

        return 0;
    }
}
