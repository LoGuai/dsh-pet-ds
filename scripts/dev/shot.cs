// 桌宠窗口截图工具：用于目视确认透明、无边框、置顶是否真的生效。
//
// 编译（本机自带 .NET Framework 的 csc，无需装 SDK）：
//   csc /nologo /out:shot.exe shot.cs /r:System.Drawing.dll
// 运行：
//   shot.exe <输出png路径> [进程名，默认 electron]
//
// 先用 PrintWindow(PW_RENDERFULLCONTENT) 抓合成内容；失败则回退到屏幕抓取。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

internal static class Shot
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    // HWND_TOPMOST = -1，配合 SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE 仅调整 z 序。
    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOACTIVATE = 0x0010;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private sealed class Candidate
    {
        public IntPtr Handle;
        public uint Pid;
        public string Class;
        public int X, Y, W, H;
        public long Area { get { return (long)W * H; } }
    }

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    private static int Main(string[] args)
    {
        // 关键：声明进程 DPI 感知。
        // 否则 GetWindowRect 返回物理像素、CopyFromScreen 用逻辑（缩放后）坐标，
        // 抓取区域会整体错位——实测踩过这个坑（抓到的是完全不相干的窗口内容）。
        try { SetProcessDPIAware(); } catch { }

        if (args.Length < 1)
        {
            Console.Error.WriteLine("用法: shot.exe <输出png> [标题关键字，默认 'DSH Pet']");
            return 1;
        }

        string outPath = args[0];
        string titleFilter = args.Length > 1 ? args[1] : "DSH Pet";

        // 用窗口标题筛选，而不是进程名：实测某些环境下 GetProcesses() 无法解析
        // Electron 子进程的名字（返回 "?"），按进程名筛会漏掉窗口。
        var found = new List<Candidate>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;

            var title = new StringBuilder(512);
            GetWindowText(hWnd, title, 512);
            string text = title.ToString();
            if (titleFilter.Length > 0 &&
                text.IndexOf(titleFilter, StringComparison.OrdinalIgnoreCase) < 0) return true;

            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            RECT r;
            if (!GetWindowRect(hWnd, out r)) return true;

            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);

            found.Add(new Candidate
            {
                Handle = hWnd,
                Pid = pid,
                Class = sb.ToString(),
                X = r.Left,
                Y = r.Top,
                W = r.Right - r.Left,
                H = r.Bottom - r.Top,
            });
            return true;
        }, IntPtr.Zero);

        if (found.Count == 0)
        {
            Console.Error.WriteLine("没有找到标题含 \"" + titleFilter + "\" 的可见窗口");
            return 3;
        }

        Console.WriteLine("找到 " + found.Count + " 个候选窗口:");
        foreach (var c in found)
        {
            Console.WriteLine(string.Format("  pid={0} class={1} {2}x{3} @ ({4},{5})", c.Pid, c.Class, c.W, c.H, c.X, c.Y));
        }

        // 挑选规则：优先 Chrome_WidgetWin_1 / HwndWrapper（真正的内容窗），
        // 再在其中取**最小**的那个。
        //
        // 为什么不是"面积最大"：Electron 会同时存在多个同标题的窗口
        // （实测有一个 270x486 的辅助窗口比 180x324 的桌宠窗还大），
        // 面积最大反而会挑错对象，让所有测量数据自相矛盾。
        // 桌宠是那个小的内容窗，所以取最小。
        Candidate pick = null;
        foreach (var c in found)
        {
            bool contentClass = c.Class == "Chrome_WidgetWin_1" || c.Class == "HwndWrapper";
            if (!contentClass) continue;
            if (c.W < 80 || c.H < 80) continue;
            if (pick == null || c.Area < pick.Area) pick = c;
        }
        if (pick == null)
        {
            // 没有符合类名要求的，退回面积最大（并明确说明，避免误读数据）。
            foreach (var c in found)
            {
                if (pick == null || c.Area > pick.Area) pick = c;
            }
            Console.Error.WriteLine("警告：未找到内容窗类名，回退到面积最大的候选窗口，测量值可能不可信");
        }

        Console.WriteLine(string.Format("截取: pid={0} {1}x{2} @ ({3},{4})", pick.Pid, pick.W, pick.H, pick.X, pick.Y));

        if (pick.W <= 0 || pick.H <= 0)
        {
            Console.Error.WriteLine("窗口尺寸无效");
            return 4;
        }

        // 抓取窗口四周更大的一块区域。
        // 原因：透明窗口用 PrintWindow 常失败，而只抓窗口自身尺寸时无法判断
        // "透明"到底是真透明还是抓到了一块纯色；带上周边桌面就能一眼看出。
        const int Pad = 140;
        int capX = pick.X - Pad;
        int capY = pick.Y - Pad;
        int capW = pick.W + Pad * 2;
        int capH = pick.H + Pad * 2;

        Console.WriteLine(string.Format("抓取区域: {0}x{1} @ ({2},{3})（含窗口四周 {4}px 桌面）", capW, capH, capX, capY, Pad));

        using (var bmp = new Bitmap(capW, capH))
        {
            bool ok;
            using (var g = Graphics.FromImage(bmp))
            {
                IntPtr hdc = g.GetHdc();
                // 2 = PW_RENDERFULLCONTENT。对分层/透明窗口可能返回 false。
                ok = PrintWindow(pick.Handle, hdc, 2);
                g.ReleaseHdc(hdc);
            }

            if (ok)
            {
                Console.WriteLine("PrintWindow 成功（抓的是窗口自身内容）");
            }
            else
            {
                // 透明/分层窗口常常不支持 PrintWindow。此时把它临时提到最前再按矩形抓屏，
                // 这样拿到的就是"桌宠实际显示出来的样子"。
                Console.WriteLine("PrintWindow 失败，改为置顶后按矩形抓屏");
                SetWindowPos(pick.Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                BringWindowToTop(pick.Handle);
                System.Threading.Thread.Sleep(500);
                using (var g = Graphics.FromImage(bmp))
                {
                    g.CopyFromScreen(capX, capY, 0, 0, new Size(capW, capH));
                }
            }

            string dir = System.IO.Path.GetDirectoryName(outPath);
            if (!string.IsNullOrEmpty(dir) && !System.IO.Directory.Exists(dir))
            {
                System.IO.Directory.CreateDirectory(dir);
            }

            bmp.Save(outPath, ImageFormat.Png);

            // 采样：窗口区域中心 vs 窗口外的桌面，用于粗判是否透明。
            // 放在同一个 using 里，避免依赖已释放的位图。
            Color center = bmp.GetPixel(
                Math.Min(Pad + pick.W / 2, bmp.Width - 1),
                Math.Min(Pad + pick.H / 2, bmp.Height - 1));
            Color outside = bmp.GetPixel(2, 2);
            Console.WriteLine(string.Format(
                "像素采样: 窗口外桌面 ARGB=({0},{1},{2},{3})  窗口中心 ARGB=({4},{5},{6},{7})",
                outside.A, outside.R, outside.G, outside.B,
                center.A, center.R, center.G, center.B));
        }

        Console.WriteLine("已保存: " + outPath);
        return 0;
    }
}
