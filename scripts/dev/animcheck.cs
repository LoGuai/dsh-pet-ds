using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
internal static class AnimCheck {
  private delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
  static IntPtr target = IntPtr.Zero; static RECT rect;
  static int Main(string[] a) {
    try { SetProcessDPIAware(); } catch {}
    string title = a.Length > 0 ? a[0] : "DSH Pet";
    int shots = a.Length > 1 ? int.Parse(a[1]) : 4;
    int gapMs = a.Length > 2 ? int.Parse(a[2]) : 220;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.ToString().IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      if ((long)(r.Right-r.Left)*(r.Bottom-r.Top) > (long)(rect.Right-rect.Left)*(rect.Bottom-rect.Top)) { target=h; rect=r; }
      return true;
    }, IntPtr.Zero);
    if (target == IntPtr.Zero) { Console.Error.WriteLine("找不到窗口"); return 2; }
    int w = rect.Right-rect.Left, hh = rect.Bottom-rect.Top;
    SetWindowPos(target, new IntPtr(-1), 0,0,0,0, 0x0002|0x0001|0x0010);
    Thread.Sleep(600);
    var shotsArr = new Bitmap[shots];
    for (int i = 0; i < shots; i++) {
      var bmp = new Bitmap(w, hh);
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(w, hh));
      shotsArr[i] = bmp;
      Thread.Sleep(gapMs);
    }
    // 两两比较：平均绝对差 + 差异像素比例
    for (int i = 1; i < shots; i++) {
      long sum = 0; long diff = 0; long n = (long)w*hh;
      var d1 = shotsArr[i-1]; var d2 = shotsArr[i];
      for (int y = 0; y < hh; y += 2) for (int x = 0; x < w; x += 2) {
        Color c1 = d1.GetPixel(x,y), c2 = d2.GetPixel(x,y);
        int dd = Math.Abs(c1.R-c2.R)+Math.Abs(c1.G-c2.G)+Math.Abs(c1.B-c2.B);
        sum += dd; if (dd > 24) diff++;
      }
      long sampled = ((long)(hh/2+1)) * ((w/2)+1);
      Console.WriteLine(string.Format("帧{i} vs 帧{i+1}: 平均像素差 {0:F2}  明显差异像素占比 {1:F2}%",
        (double)sum/sampled, 100.0*diff/sampled));
    }
    for (int i = 0; i < shots; i++) shotsArr[i].Save("D:\\dsh\\pet\\_research\\anim-" + (i+1) + ".png", ImageFormat.Png);
    var tb = new Bitmap((w/2)*shots, hh/2);
    return 0;
  }
}
