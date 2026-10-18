// DSH 桌宠插件 · 安装程序
//
// 目标（用户要求）：
//   1. 把插件包体**一键安装到任意目录**；
//   2. **自动配置 DSH**，装完能正常启用。
//
// 编译：用 Windows 自带的 .NET Framework csc.exe（无需任何额外安装）
//   csc /target:winexe /out:setup.exe /resource:payload.zip,payload Setup.cs MiniZip.cs
//   见 scripts/dev/build-installer.mjs
//
// 三种运行方式：
//   setup.exe                        界面安装（默认）
//   setup.exe --silent <目录>        无界面安装（给自动化用）
//   setup.exe --selftest <目录>      只解压并逐项自检（验证载荷与解压器）
//
// 设计要点：
//   · 包体（含依赖树）内嵌为资源，所以 setup.exe 是单文件，拷到哪都能跑；
//   · 解压用自写的 MiniZip（为兼容 .NET 4.0，见 MiniZip.cs 的说明）；
//   · 配置 DSH = 改 profile 的 package.json 两处 + 跑一次 pnpm install，
//     与仓库里的 scripts/install.mjs 完全一致（保持单一真相）；
//   · 界面模式与静默模式**共用同一套安装逻辑**（InstallCore），避免漂移。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace DshPetSetup
{
    internal static class Program
    {
        /**
         * 本进程是否已获得管理员权限。
         *
         * `WindowsPrincipal.IsInRole(Administrator)` 在 UAC 下对
         * "属于管理员组但未提升"的进程返回 false —— 正是我们要判定的。
         */
        internal static bool IsElevated()
        {
            try
            {
                var id = System.Security.Principal.WindowsIdentity.GetCurrent();
                var pr = new System.Security.Principal.WindowsPrincipal(id);
                return pr.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
            }
            catch
            {
                /* 判定不了就当作已提升，避免反复自我重启把用户烦死 */
                return true;
            }
        }

        /**
         * 兜底：若没提升权限，用 `runas` 重新启动自己并退出。
         *
         * ## 正常情况下走不到这里
         *
         * 构建时已经把 `requireAdministrator` 编进清单了（见 installer/setup.manifest），
         * Windows 在**加载 exe 之前**就会弹 UAC。所以本函数通常只是白跑一次判定。
         *
         * ## 那为什么还要留
         *
         * 清单可能因为构建环境缺 `csc /win32manifest` 支持、或有人手工改过 exe
         * 而不生效。那时若什么都不做，安装会在**解压到一半**时才因权限不足失败
         * —— 报错晚且难懂。这里有兜底，至少能提升成功、继续装完。
         *
         * ## `--elevated` 防死循环
         *
         * 重启时带上 `--elevated`；若那个子进程**仍然**没提升（例如用户点了
         * "否"、或策略禁止提升），它不会再重启一次，而是直接继续 ——
         * 否则会无限自我重启。
         *
         * @returns true 表示"已经重启了子进程，本进程应当立刻退出"
         */
        private static bool TryElevate(string[] args)
        {
            if (IsElevated()) return false;
            foreach (var a in args ?? new string[0])
            {
                if (a == "--elevated") return false;   // 已经是重试过的，不再重启
            }

            try
            {
                var exe = System.Reflection.Assembly.GetExecutingAssembly().Location;
                var psi = new ProcessStartInfo
                {
                    FileName = exe,
                    UseShellExecute = true,      // runas 需要 ShellExecute
                    Verb = "runas",              // 触发 UAC
                    WorkingDirectory = Path.GetDirectoryName(exe) ?? Environment.CurrentDirectory,
                };
                /*
                 * 参数要**逐个加引号**：安装目录可能含空格
                 * （例如 `C:\Program Files\DSH-Pet`），不加引号会被拆成多个参数。
                 */
                var quoted = new List<string>();
                foreach (var a in args ?? new string[0]) quoted.Add("\"" + a.Replace("\"", "\\\"") + "\"");
                quoted.Add("\"--elevated\"");
                psi.Arguments = string.Join(" ", quoted.ToArray());

                Process.Start(psi);
                return true;
            }
            catch (Exception ex)
            {
                /*
                 * 最常见的是用户点了 UAC 的"否"（抛 Win32Exception 1223 = 操作被取消）。
                 * 不当作致命错误：继续以当前权限跑，让安装流程自己给出
                 * "写入被拒"的明确报错（比在这里静默退出好）。
                 */
                Console.Error.WriteLine("（未能提升权限：" + ex.Message + "）");
                return false;
            }
        }

        [STAThread]
        private static void Main(string[] args)
        {
            /*
             * 统一用 UTF-8 输出。
             *
             * .NET 的 `Console.OutputEncoding` 默认跟随**系统代码页**（中文版是 GBK/936）。
             * 输出被重定向到管道/文件时（自动化测试、日志收集）就会写成 GBK 字节，
             * 而消费者（Node、编辑器、CI）通常按 UTF-8 读 —— 结果是一片 `�`，
             * 而且**信息不可恢复**（UTF-8 解码 GBK 字节会产生替换字符）。
             *
             * 这不会影响用户在控制台里直接看的场景：现代 Windows 终端能正确显示 UTF-8。
             * 设置失败也不该让安装中断（老系统上偶有 IOException），所以吞掉异常。
             */
            try
            {
                Console.OutputEncoding = new UTF8Encoding(false);
            }
            catch
            {
                // 忽略：编码设置失败不影响安装流程
            }

            if (args != null && args.Length >= 1 && args[0] == "--selftest")
            {
                var target = args.Length >= 2
                    ? args[1]
                    : Path.Combine(Path.GetTempPath(), "dsh-pet-setup-selftest");
                Environment.ExitCode = SelfTest.Run(target);
                return;
            }

            if (args != null && args.Length >= 1 && args[0] == "--silent")
            {
                if (args.Length < 2)
                {
                    Console.Error.WriteLine("用法：setup.exe --silent <安装目录>");
                    Environment.ExitCode = 2;
                    return;
                }
                /* 静默模式也先确保权限 —— 自动化里更需要一次到位。 */
                if (TryElevate(args)) return;
                Environment.ExitCode = Installer.Run(args[1], Console.WriteLine) ? 0 : 1;
                return;
            }

            /* 界面模式：启动前先确保有管理员权限（通常清单已经处理了）。 */
            if (TryElevate(args)) return;

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
        }
    }

    // ================================================================ 安装核心
    /**
     * 安装的核心逻辑。界面模式与静默模式都走这里。
     *
     * 抽成静态类（不依赖窗口）是为了能被自检/静默模式直接调用 ——
     * 若让静默模式去"假装点按钮"，两边迟早漂移，而这是"装完能不能用"的关键。
     */
    internal static class Installer
    {
        /** 插件包名。与 package.json 的 name 一致，DSH 靠它认插件。 */
        internal const string PluginName = "dsh-pet-ds";

        /**
         * 一键安装时安装的 Electron 版本。
         *
         * 刻意钉住，而不是取最新稳定版：桌宠的窗口尺寸/透明/置顶行为是在
         * 38.2.0 上验过的。一键安装的目标是"装完就能用"，
         * 不该在装机时顺带把运行时升级到一个没验过的版本。
         * 与本仓库 `install-pet.ps1` 的 `-ElectronVersion` 默认值保持一致。
         */
        internal const string ElectronVersion = "38.2.0";

        /** 子目录名：用户选的是"装到哪个目录"，插件本体放它下面的这个子目录。 */
        internal const string SubDirName = "dsh-pet-ds";

        /** 记录上一次失败原因，供界面弹窗用。 */
        internal static string LastError;

        internal static bool Run(string baseDir, Action<string> log)
        {
            return Run(baseDir, log, delegate(string s, int p) { });
        }

        internal static bool Run(string baseDir, Action<string> log, Action<string, int> status)
        {
            LastError = null;
            var pluginDir = Path.Combine(baseDir ?? "", SubDirName);
            try
            {
                // ---- 预检
                status("检查安装目录…", 3);
                if (string.IsNullOrWhiteSpace(baseDir))
                {
                    return Fail(log, "安装目录为空。");
                }
                if (!Path.IsPathRooted(baseDir))
                {
                    return Fail(log, "安装目录必须是绝对路径（例如 D:\\DSH-Pet）。");
                }
                log("[1/6] 准备安装目录");
                log("      目标：" + pluginDir);
                /*
                 * 升级时先清掉旧版本文件（用户要求：不用手动卸载旧版本）。
                 *
                 * 这一步必须在**解压之前**：载荷是"叠加解压"的，
                 * 不清就会留下新版本里已经不存在的旧文件（旧素材、旧脚本），
                 * 那种残留最难查 —— 表现为"装的是新版、跑的还是旧代码"。
                 *
                 * 目录的创建与"能不能清"的判断都在 PrepareTargetDir 里。
                 */
                if (!PrepareTargetDir(pluginDir, log))
                {
                    return false;
                }

                // ---- 解压载荷
                status("解压插件包体…", 10);
                log("");
                log("[2/6] 解压插件包体（含依赖树，约 115 MB）");
                var payload = Payload.Bytes;
                if (payload == null)
                {
                    return Fail(log, "安装程序内部缺少载荷资源（payload）。这个 exe 可能被改坏了。");
                }
                log("      载荷大小：" + (payload.Length / 1024 / 1024) + " MB");
                var count = 0;
                try
                {
                    count = new MiniZip().ExtractAll(payload, pluginDir, delegate(string name)
                    {
                        count++;
                        if (count % 40 == 0) status("解压中… " + count + " 个文件", 10 + Math.Min(35, count / 6));
                    });
                }
                catch (Exception ex)
                {
                    return Fail(log, "解压失败：" + ex.GetType().Name + ": " + ex.Message);
                }
                log("      ✓ 解出 " + count + " 个文件");

                if (!File.Exists(Path.Combine(pluginDir, "package.json")))
                {
                    return Fail(log, "解压后没找到 package.json —— 载荷不完整。");
                }
                log("      ✓ package.json 就位");
                log("      ✓ cordis.patch.yml：" + File.Exists(Path.Combine(pluginDir, "cordis.patch.yml")));

                // ---- 找 DSH
                status("定位 DSH…", 50);
                log("");
                log("[3/6] 定位 DSH");
                var dshHome = DshLocator.FindHome();
                if (dshHome == null)
                {
                    return Fail(log,
                        "找不到 DSH 的配置目录。\n" +
                        "请先安装并**至少打开一次** DeepSeek Harness，然后重新运行本安装程序。\n" +
                        "（也支持用环境变量 DSH_HOME 指定。）");
                }
                log("      ✓ DSH home：" + dshHome);

                var profileDir = DshLocator.FindProfile(dshHome);
                if (profileDir == null)
                {
                    return Fail(log,
                        "在 " + Path.Combine(dshHome, "profiles") + " 下没找到任何 profile。\n" +
                        "请先打开一次 DSH 让它生成 profile，再重试。");
                }
                log("      ✓ 目标 profile：" + Path.GetFileName(profileDir));
                log("        " + profileDir);

                // ---- 登记进 profile
                status("配置 DSH…", 58);
                log("");
                log("[4/6] 把插件登记进 DSH profile");
                var profileJson = Path.Combine(profileDir, "package.json");
                if (!File.Exists(profileJson))
                {
                    return Fail(log, "profile 里缺少 package.json：" + profileJson);
                }

                var backup = profileJson + ".bak-before-" + PluginName;
                if (!File.Exists(backup))
                {
                    File.Copy(profileJson, backup);
                    log("      ✓ 已备份原配置：" + Path.GetFileName(backup));
                }
                else
                {
                    log("      · 备份已存在，未覆盖：" + Path.GetFileName(backup));
                }

                var original = File.ReadAllText(profileJson, new UTF8Encoding(false));
                string modified;
                try
                {
                    modified = ProfileConfig.Apply(original, PluginName, pluginDir);
                }
                catch (Exception ex)
                {
                    // 原文件没动过，备份也在 —— 明确告诉用户怎么回退
                    log("✗ 改配置失败：" + ex.Message);
                    log("  原配置未被改动；备份为 " + Path.GetFileName(backup));
                    LastError = ex.Message;
                    return false;
                }

                if (modified == original)
                {
                    log("      · 配置已是最新（无需改动）");
                }
                else
                {
                    // 无 BOM 写回：带 BOM 的 JSON 在某些解析器下会出问题
                    File.WriteAllText(profileJson, modified, new UTF8Encoding(false));
                    log("      ✓ bundles 已加入 " + PluginName);
                    log("      ✓ dependencies 已指向 " + pluginDir);
                }

                // ---- 校验
                status("校验安装…", 78);
                log("");
                log("[5/6] 校验");

                var entry = Path.Combine(pluginDir, "src", "host", "index.js");
                if (!File.Exists(entry))
                {
                    return Fail(log, "插件入口不存在：" + entry);
                }
                log("      ✓ 插件入口存在：src\\host\\index.js");

                if (Directory.Exists(Path.Combine(pluginDir, "node_modules")))
                {
                    log("      ✓ 自带依赖树存在（node_modules）");
                }
                else
                {
                    log("      ⚠ 没有 node_modules —— 稍后会用 pnpm 尝试补装");
                }

                /*
                 * 为什么要跑 pnpm install：DSH 加载插件时会从 profile 的
                 * node_modules 解析它。只改 package.json 而不跑这一步，DSH 会
                 * 找不到这个包（与仓库 install.mjs 第 3–4 步的结论一致）。
                 *
                 * 失败不算致命 —— 自带依赖树已经能让插件跑起来。
                 */
                var pnpm = DshLocator.FindPnpm(dshHome);
                if (pnpm == null)
                {
                    log("      ⚠ 没找到 pnpm；如果重启 DSH 后插件没出现，");
                    log("        请手动在下面这个目录跑一次 pnpm install：");
                    log("        " + profileDir);
                }
                else
                {
                    status("刷新 profile 依赖…", 86);
                    log("      · 用 DSH 自带的 pnpm 刷新 profile 依赖…");
                    var okPnpm = DshLocator.RunPnpm(pnpm, profileDir, delegate(string l) { log("        " + l); });
                    log(okPnpm ? "      ✓ pnpm install 完成" : "      ⚠ pnpm install 未成功（见上面的输出）");
                }

                // ---- Electron 运行时
                /*
                 * 为什么要这一步：桌宠的窗口进程是**独立 Electron**，不是 DSH 自带的那份
                 * （DSH 的 `DeepSeek Harness.exe` 是改造过的载体，把应用目录当参数传给它
                 * 会直接退出）。缺了它，插件能装好、能被加载，但**桌宠窗口不会出现** ——
                 * 现象是"装了却什么都没有"，用户几乎无法自行归因。
                 *
                 * 失败不算致命：插件本身已经装好，这里只把补救命令明确打出来。
                 */
                status("安装 Electron 运行时…", 92);
                log("");
                log("[6/6] Electron 运行时");
                var electronExe = DshLocator.FindElectron(dshHome);
                if (electronExe != null)
                {
                    log("      ✓ 已有：" + electronExe);
                }
                else
                {
                    var nodeExe = DshLocator.FindNode(dshHome);
                    var electronInstaller = Path.Combine(pluginDir, "scripts", "dev", "install-electron.mjs");
                    if (nodeExe == null)
                    {
                        log("      ⚠ 找不到 node.exe，跳过 Electron 安装");
                        log("        桌宠窗口需要独立 Electron；若重启后桌宠不出现，请手动执行：");
                        log("        node \"" + electronInstaller + "\"");
                    }
                    else if (!File.Exists(electronInstaller))
                    {
                        log("      ⚠ 插件里没有 install-electron.mjs，跳过 Electron 安装");
                        log("        若重启后桌宠不出现，请按插件目录里的 INSTALL.md 手动安装 Electron。");
                    }
                    else
                    {
                        log("      · 下载并安装 Electron（约 100 MB，需联网）…");
                        /*
                         * ⚠️ 钉住版本，而不是"取最新稳定版"。
                         * 桌宠的窗口尺寸/透明/置顶行为是在 38.2.0 上验过的，
                         * 一键安装的目标是"装完就能用"，不该在装机时顺带升级运行时。
                         */
                        var okElectron = DshLocator.RunNodeScript(
                            nodeExe, electronInstaller, "--version=" + ElectronVersion, pluginDir, dshHome, 600000,
                            delegate(string l) { log("        " + l); });
                        if (okElectron)
                        {
                            log("      ✓ Electron 安装完成");
                        }
                        else
                        {
                            log("      ⚠ Electron 安装未成功 —— 插件已装好，但桌宠窗口起不来");
                            log("        联网后重跑本安装程序，或手动执行：");
                            log("        node \"" + electronInstaller + "\"");
                        }
                    }
                }

                // ---- 完成
                status("完成。", 100);
                log("");
                log("=====================");
                log("安装完成。");
                log("");
                log("接下来：**重启 DSH**（插件是在启动时加载的）。");
                log("重启后应看到：");
                log("  · 桌宠自动出现（autoStart 默认开启）");
                log("  · 模型工具 DSHpet_status / DSHpet_balance / DSHpet_control 可用");
                log("  · DSH 设置页里出现「桌宠」一栏");
                log("");
                log("如果桌宠没出现：先看 DSH 的插件页有没有报 failed to import，");
                log("再按插件目录里的 INSTALL.md「排障」一节逐项核对。");
                return true;
            }
            catch (Exception ex)
            {
                LastError = ex.Message;
                log("✗ 安装过程中出错：" + ex.GetType().Name + ": " + ex.Message);
                return false;
            }
        }

        private static bool Fail(Action<string> log, string message)
        {
            LastError = message;
            log("");
            log("✗ " + message.Replace("\n", Environment.NewLine + "  "));
            return false;
        }

        /**
         * 准备目标目录：**升级时先清掉旧版本文件**（用户要求：
         * "安装新版本时先移除旧版本文件，不用手动提前卸载旧版本"）。
         *
         * ## 为什么不能直接"清空目录"
         *
         * 安装目录是**用户自己选**的。如果他把目录指到一个有别的文件的文件夹
         * （比如 `D:\Downloads`），无脑清空就是灾难。
         *
         * 所以只在一个条件下才清：目录里存在 `package.json` 且它的 `name`
         * 就是本插件 —— 那说明这是一个"以前的桌宠安装目录"，里面的文件都是我们的。
         * 其它非空目录一律**拒绝安装**并让用户换一个，宁可多一步也不误删。
         *
         * ## 用户数据不受影响
         *
         * 桌宠的本地配置与日志在 `<DSH_HOME>\dsh-pet-ds\`，**不在**安装目录里，
         * 所以清库不会丢好感/尺寸设置。
         */
        private static bool PrepareTargetDir(string pluginDir, Action<string> log)
        {
            if (!Directory.Exists(pluginDir))
            {
                try
                {
                    Directory.CreateDirectory(pluginDir);
                }
                catch (Exception ex)
                {
                    return Fail(log, "无法创建目录：" + ex.Message);
                }
                log("      ✓ 目录可用（新建）");
                return true;
            }

            var entries = Directory.GetFileSystemEntries(pluginDir);
            if (entries.Length == 0)
            {
                log("      ✓ 目录可用（空目录）");
                return true;
            }

            // 判断"这是不是以前的桌宠安装目录"
            var looksLikePetDir = false;
            var oldVersion = "未知版本";
            var pkgJson = Path.Combine(pluginDir, "package.json");
            if (File.Exists(pkgJson))
            {
                try
                {
                    var text = File.ReadAllText(pkgJson, new UTF8Encoding(false));
                    // 不引依赖，简单判两个字段即可
                    looksLikePetDir = text.Contains("\"" + PluginName + "\"");
                    var m = System.Text.RegularExpressions.Regex.Match(text, "\"version\"\\s*:\\s*\"([^\"]+)\"");
                    if (m.Success) oldVersion = "v" + m.Groups[1].Value;
                }
                catch
                {
                    looksLikePetDir = false;
                }
            }

            if (!looksLikePetDir)
            {
                log("      [refuse] 目标目录非空，且不是之前安装的桌宠目录：" + pluginDir);
                return Fail(log,
                    "目标目录非空，而且看起来不是之前安装的桌宠目录：\n" + pluginDir +
                    "\n为避免误删你的文件，请换一个空目录（或先手动清空它）。");
            }

            /*
             * 日志里带一个 ASCII 标签 `[upgrade]`：中文在不同控制台代码页下
             * 可能变成乱码，而自动化测试/日志检索需要稳定的锚点。
             */
            log("      [upgrade] 检测到旧版本（" + oldVersion + "），先移除旧版本文件 …");
            var removed = 0;
            try
            {
                foreach (var dir in Directory.GetDirectories(pluginDir))
                {
                    Directory.Delete(dir, true);
                    removed++;
                }
                foreach (var file in Directory.GetFiles(pluginDir))
                {
                    File.Delete(file);
                    removed++;
                }
            }
            catch (Exception ex)
            {
                return Fail(log,
                    "清理旧版本文件失败：" + ex.Message +
                    "\n请先关掉正在运行的桌宠，或手动删除这个目录后重试：\n" + pluginDir);
            }
            log("      ✓ 已清理 " + removed + " 项旧文件（用户配置与日志不在这个目录，未受影响）");
            return true;
        }
    }

    // ================================================================ 载荷
    /**
     * 内嵌的载荷（构建时用 `csc /resource:<zip>,payload` 放进来）。
     *
     * ⚠️ 这个取法**有静默失败的风险**：资源名写错时 `GetManifestResourceStream`
     * 只返回 null、不抛异常。所以：
     *   · 这里返回 null，调用方给出可读的失败信息；
     *   · 构建脚本另有一条断言，确认 exe 体积包含载荷（见 build-installer.mjs）。
     *
     * （最初把载荷写成 C# 字节字面量以避免这个问题，但 1.15 亿个元素让
     *   csc 编译慢到不可用 —— 实测 409 MB 源码、几分钟不结束，只能放弃。）
     */
    internal static class Payload
    {
        private static byte[] _bytes;
        private static bool _loaded;

        internal static byte[] Bytes
        {
            get
            {
                if (_loaded) return _bytes;
                _loaded = true;
                try
                {
                    var asm = typeof(Payload).Assembly;
                    using (var s = asm.GetManifestResourceStream("payload"))
                    {
                        if (s == null) return null;
                        using (var ms = new MemoryStream())
                        {
                            var buffer = new byte[1024 * 1024];
                            int read;
                            while ((read = s.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                ms.Write(buffer, 0, read);
                            }
                            _bytes = ms.ToArray();
                        }
                    }
                }
                catch
                {
                    _bytes = null;
                }
                return _bytes;
            }
        }
    }

    // ================================================================ 界面
    internal sealed class SetupForm : Form
    {
        private TextBox _dirBox;
        private TextBox _logBox;
        private Button _installButton;
        private Button _browseButton;
        private ProgressBar _progress;
        private Label _statusLabel;
        private CheckBox _launchCheck;

        internal SetupForm()
        {
            BuildUi();
        }

        private void BuildUi()
        {
            Text = "DSH 桌宠插件 · 安装程序";
            ClientSize = new Size(680, 540);
            MinimumSize = new Size(580, 480);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 9f);
            BackColor = Color.FromArgb(250, 250, 252);

            Controls.Add(new Label
            {
                Text = "DSH 桌宠插件",
                Font = new Font("Microsoft YaHei UI", 16f, FontStyle.Bold),
                ForeColor = Color.FromArgb(30, 34, 45),
                AutoSize = true,
                Location = new Point(22, 18),
            });

            Controls.Add(new Label
            {
                Text = "把插件安装到指定目录，并自动配置 DSH —— 装完重启 DSH 即可看到桌宠。",
                ForeColor = Color.FromArgb(110, 116, 130),
                AutoSize = true,
                Location = new Point(24, 54),
            });

            Controls.Add(new Label { Text = "安装目录", AutoSize = true, Location = new Point(24, 92) });

            _dirBox = new TextBox
            {
                Location = new Point(24, 114),
                Width = 520,
                Text = DefaultInstallDir(),
            };
            Controls.Add(_dirBox);

            _browseButton = new Button { Text = "浏览…", Location = new Point(554, 112), Width = 100, Height = 26 };
            _browseButton.Click += delegate { Browse(); };
            Controls.Add(_browseButton);

            _launchCheck = new CheckBox
            {
                Text = "安装完成后打开插件目录",
                Checked = true,
                AutoSize = true,
                Location = new Point(26, 148),
            };
            Controls.Add(_launchCheck);

            _installButton = new Button
            {
                Text = "开始安装",
                Location = new Point(24, 180),
                Width = 130,
                Height = 34,
                BackColor = Color.FromArgb(59, 130, 246),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
            };
            _installButton.FlatAppearance.BorderSize = 0;
            _installButton.Click += delegate { StartInstall(); };
            Controls.Add(_installButton);

            _progress = new ProgressBar
            {
                Location = new Point(170, 185),
                Width = 484,
                Height = 24,
                Style = ProgressBarStyle.Continuous,
            };
            Controls.Add(_progress);

            _statusLabel = new Label
            {
                Text = "就绪。",
                ForeColor = Color.FromArgb(80, 86, 100),
                AutoSize = true,
                Location = new Point(170, 214),
            };
            Controls.Add(_statusLabel);

            _logBox = new TextBox
            {
                Location = new Point(24, 244),
                Width = 630,
                Height = 274,
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                BackColor = Color.FromArgb(24, 26, 33),
                ForeColor = Color.FromArgb(200, 210, 225),
                Font = new Font("Consolas", 9f),
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom,
            };
            Controls.Add(_logBox);

            Log("DSH 桌宠插件安装程序");
            Log("=====================");
            Log("将执行：解压插件包体 → 登记进 DSH profile → 校验依赖解析");
            Log("");
        }

        /** 默认安装目录：`%LOCALAPPDATA%\DSH-Pet`（可改成任意目录）。 */
        private static string DefaultInstallDir()
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(local)) local = Path.GetTempPath();
            return Path.Combine(local, "DSH-Pet");
        }

        private void Browse()
        {
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.Description = "选择安装目录";
                dlg.ShowNewFolderButton = true;
                if (Directory.Exists(_dirBox.Text)) dlg.SelectedPath = _dirBox.Text;
                if (dlg.ShowDialog(this) == DialogResult.OK) _dirBox.Text = dlg.SelectedPath;
            }
        }

        private void Log(string line)
        {
            if (_logBox.InvokeRequired)
            {
                _logBox.BeginInvoke(new Action<string>(Log), line);
                return;
            }
            _logBox.AppendText(line + Environment.NewLine);
        }

        private void Status(string text, int percent)
        {
            if (_statusLabel.InvokeRequired)
            {
                _statusLabel.BeginInvoke(new Action<string, int>(Status), text, percent);
                return;
            }
            _statusLabel.Text = text;
            _progress.Value = Math.Max(0, Math.Min(100, percent));
        }

        private void StartInstall()
        {
            _installButton.Enabled = false;
            _browseButton.Enabled = false;
            _dirBox.Enabled = false;
            var baseDir = _dirBox.Text.Trim();
            var thread = new Thread(delegate()
            {
                var ok = Installer.Run(baseDir, Log, Status);
                Finish(ok, baseDir);
            });
            thread.IsBackground = true;
            thread.Start();
        }

        private void Finish(bool ok, string baseDir)
        {
            if (InvokeRequired)
            {
                BeginInvoke(new Action<bool, string>(Finish), ok, baseDir);
                return;
            }
            _installButton.Enabled = true;
            _browseButton.Enabled = true;
            _dirBox.Enabled = true;
            _installButton.Text = ok ? "重新安装" : "重试";

            if (!ok)
            {
                Status("失败。", 0);
                MessageBox.Show(this, Installer.LastError ?? "安装未完成（见日志）。",
                    "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            if (_launchCheck.Checked && baseDir != null)
            {
                try
                {
                    Process.Start("explorer.exe", "\"" + baseDir + "\"");
                }
                catch
                {
                    // 打不开资源管理器不算失败
                }
            }
        }
    }

    // ================================================================ DSH 探测
    internal static class DshLocator
    {
        /** 依次从环境变量、常见位置找 DSH home（含 profiles 目录）。 */
        internal static string FindHome()
        {
            var candidates = new List<string>();
            var env = Environment.GetEnvironmentVariable("DSH_HOME");
            if (!string.IsNullOrEmpty(env)) candidates.Add(env);
            var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!string.IsNullOrEmpty(userProfile)) candidates.Add(Path.Combine(userProfile, ".dsh"));

            foreach (var c in candidates)
            {
                try
                {
                    if (!string.IsNullOrEmpty(c) && Directory.Exists(Path.Combine(c, "profiles"))) return c;
                }
                catch
                {
                    // 继续试下一个
                }
            }
            return null;
        }

        /**
         * 选目标 profile。
         *
         * 优先 `DSH_PROFILE`；否则只有一个就用它；
         * 多个时优先 `desktop`（DSH 桌面端的默认名）。
         */
        internal static string FindProfile(string dshHome)
        {
            var root = Path.Combine(dshHome, "profiles");
            if (!Directory.Exists(root)) return null;

            var wanted = Environment.GetEnvironmentVariable("DSH_PROFILE");
            if (!string.IsNullOrEmpty(wanted))
            {
                var p = Path.Combine(root, wanted);
                if (Directory.Exists(p)) return p;
            }

            var dirs = Directory.GetDirectories(root);
            if (dirs.Length == 0) return null;
            if (dirs.Length == 1) return dirs[0];
            foreach (var d in dirs)
            {
                if (string.Equals(Path.GetFileName(d), "desktop", StringComparison.OrdinalIgnoreCase)) return d;
            }
            return dirs[0];
        }

        /** 找 DSH 自带的 pnpm（node.exe + pnpm.mjs）。 */
        internal static string[] FindPnpm(string dshHome)
        {
            try
            {
                var root = Path.Combine(dshHome, "dsh-runtimes");
                if (!Directory.Exists(root)) return null;
                foreach (var rt in Directory.GetDirectories(root))
                {
                    var node = Path.Combine(rt, "dependencies", "node", "bin", "node.exe");
                    var script = Path.Combine(rt, "dependencies", "pnpm", "bin", "pnpm.mjs");
                    if (File.Exists(node) && File.Exists(script)) return new[] { node, script };
                }
            }
            catch
            {
                // 忽略
            }
            return null;
        }

        /** 只找 node.exe（跑 Electron 安装脚本用，不要求 pnpm 也在）。 */
        internal static string FindNode(string dshHome)
        {
            try
            {
                var root = Path.Combine(dshHome, "dsh-runtimes");
                if (!Directory.Exists(root)) return null;
                foreach (var rt in Directory.GetDirectories(root))
                {
                    var node = Path.Combine(rt, "dependencies", "node", "bin", "node.exe");
                    if (File.Exists(node)) return node;
                }
            }
            catch
            {
                // 忽略
            }
            return null;
        }

        /**
         * 找**已装好的独立 Electron**：`<dshHome>\electron\electron-v*-win32-x64\electron.exe`。
         *
         * 这个布局是 `install-electron.mjs` 的安装约定，也是宿主探测逻辑
         * （`src/host/electron-locate.js`）的第 3 优先级。两边必须一致。
         */
        internal static string FindElectron(string dshHome)
        {
            try
            {
                var root = Path.Combine(dshHome, "electron");
                if (!Directory.Exists(root)) return null;
                foreach (var dir in Directory.GetDirectories(root))
                {
                    var name = Path.GetFileName(dir);
                    if (name.StartsWith("electron-v", StringComparison.OrdinalIgnoreCase)
                        && name.EndsWith("-win32-x64", StringComparison.OrdinalIgnoreCase))
                    {
                        var exe = Path.Combine(dir, "electron.exe");
                        if (File.Exists(exe)) return exe;
                    }
                }
            }
            catch
            {
                // 忽略
            }
            return null;
        }

        /**
         * 用 DSH 自带的 node.exe 跑一个 .mjs 脚本，输出逐行回调。返回是否成功。
         *
         * 与 `RunPnpm` 的区别：
         *  · 可以把 **DSH_HOME 显式传下去**（`install-electron.mjs` 靠它决定装到哪）；
         *  · 超时更长 —— 这一步要下载约 100 MB 的 Electron。
         */
        internal static bool RunNodeScript(string nodeExe, string scriptPath, string extraArgs,
                                           string cwd, string dshHome, int timeoutMs, Action<string> onLine)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = nodeExe,
                    Arguments = "\"" + scriptPath + "\""
                                + (string.IsNullOrEmpty(extraArgs) ? "" : " " + extraArgs),
                    WorkingDirectory = cwd,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                };
                /*
                 * ⚠️ 必须显式传 DSH_HOME。
                 *
                 * `install-electron.mjs` 按 `DSH_HOME ?? %USERPROFILE%\.dsh` 决定装到哪，
                 * 而本程序的 dshHome 可能是探测出来的、也可能来自环境变量。
                 * 不传的话会装到用户默认目录，与这里认定的位置不一致 ——
                 * 桌宠之后照样找不到 Electron，表现还是"装了没画面"。
                 */
                if (!string.IsNullOrEmpty(dshHome))
                {
                    psi.EnvironmentVariables["DSH_HOME"] = dshHome;
                }
                using (var proc = Process.Start(psi))
                {
                    if (proc == null) return false;
                    proc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                    {
                        if (e.Data != null && onLine != null) onLine(e.Data);
                    };
                    proc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                    {
                        if (e.Data != null && onLine != null) onLine(e.Data);
                    };
                    proc.BeginOutputReadLine();
                    proc.BeginErrorReadLine();
                    if (!proc.WaitForExit(timeoutMs))
                    {
                        try
                        {
                            proc.Kill();
                        }
                        catch
                        {
                            // 忽略
                        }
                        if (onLine != null) onLine("（超时 " + (timeoutMs / 1000) + " 秒，已终止）");
                        return false;
                    }
                    return proc.ExitCode == 0;
                }
            }
            catch (Exception ex)
            {
                if (onLine != null) onLine("执行失败：" + ex.Message);
                return false;
            }
        }

        /** 跑一次 pnpm install，输出逐行回调。返回是否成功。 */
        internal static bool RunPnpm(string[] pnpm, string cwd, Action<string> onLine)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = pnpm[0],
                    /*
                     * ⚠️ 这两个开关都是**必需**的，各修一个实测踩到的坑。
                     *
                     * 1) `--ignore-workspace`
                     *
                     * pnpm 会**向上寻找工作区根**（读 `pnpm-workspace.yaml`）。
                     * 如果 profile 恰好位于某个工作区内部（例如 DSH 装在
                     * 一个带 `pnpm-workspace.yaml` 的项目里），pnpm 会把这次
                     * 安装归到"工作区根"去做，而**完全不碰** profile 目录 ——
                     * 表现为装完之后 `profile/node_modules` 里还是没有这个插件，
                     * 于是 DSH 仍然找不到它。
                     *
                     * 实测：不加这个开关时输出的是 `../..` 前缀的进度，
                     * 并且在仓库里会去装仓库自己的 devDependencies
                     * （含 112 MB 的 Electron）→ 白白超时。
                     *
                     * 2) `--config.confirmModulesPurge=false`
                     *
                     * 插件目录自带 `node_modules`（载荷里带的）。pnpm 重建它之前
                     * 会问"是否清空现有 node_modules"，而非交互环境（本安装程序
                     * 拉起的子进程没有控制台）里它直接放弃：
                     *
                     *   ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
                     *
                     * （pnpm 的提示里也这么建议：CI 下设 CI=true 或
                     *   confirmModulesPurge=false。）
                     *
                     * 3) `--config.auto-install-peers=false`
                     *
                     * 插件把 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools`
                     * 声明为 peerDependencies，而这两个包是 **DSH 在运行时注入**的
                     * （打包在 DSH 的 app.asar 里；profile 的 node_modules 里没有）。
                     * pnpm 默认会去装 peer，于是想从 npm 源抓
                     * `@deepseek-ai/dsh-tools@>=0.2.0` —— 源上只有
                     * `0.2.0-rc.2`(next) 与 `0.2.1-alpha.5`(alpha)，没有稳定版，
                     * 会以 `ERR_PNPM_NO_MATCHING_VERSION` 失败。
                     *
                     * 实测 `pnpm install`（本程序走的这条）目前不受影响，
                     * 而 `pnpm add`（install-pet.ps1 走的）会失败。这里一并加上，
                     * 免得将来 pnpm 改了默认行为又踩一次。
                     */
                    Arguments =
                        "\"" + pnpm[1] + "\" install --ignore-workspace --config.confirmModulesPurge=false --config.auto-install-peers=false",
                    WorkingDirectory = cwd,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                };
                using (var proc = Process.Start(psi))
                {
                    if (proc == null) return false;
                    proc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                    {
                        if (e.Data != null && onLine != null) onLine(e.Data);
                    };
                    proc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                    {
                        if (e.Data != null && onLine != null) onLine(e.Data);
                    };
                    proc.BeginOutputReadLine();
                    proc.BeginErrorReadLine();
                    if (!proc.WaitForExit(180000))
                    {
                        try
                        {
                            proc.Kill();
                        }
                        catch
                        {
                            // 忽略
                        }
                        if (onLine != null) onLine("（超时 180 秒，已终止）");
                        return false;
                    }
                    return proc.ExitCode == 0;
                }
            }
            catch (Exception ex)
            {
                if (onLine != null) onLine("执行失败：" + ex.Message);
                return false;
            }
        }
    }

    // ================================================================ profile 配置
    /**
     * 改 profile 的 `package.json`：把插件加进 `dsh.profile.bundles`，
     * 并把 `dependencies[插件名]` 指向安装目录。
     *
     * 为什么手写文本改写而不用 JSON 库：目标框架是 .NET Framework 4.0
     * （Windows 自带、无需额外安装），那个版本**没有** `System.Text.Json`，
     * 引入 Newtonsoft 又会让 setup.exe 变成多文件。
     *
     * 所以做**保守的文本改写**：
     *   · 只动这两个已知位置；
     *   · 保留原文件的一切格式（缩进、换行、键序、注释）；
     *   · 找不到预期结构就抛异常，绝不猜着改。
     *
     * ⚠️ 保格式很要紧：这个文件是 DSH 的配置，被人手改过是常态，
     * "重新序列化"式改写会把用户的格式与注释全冲掉。
     */
    internal static class ProfileConfig
    {
        internal static string Apply(string json, string pluginName, string pluginDir)
        {
            var result = json;

            // ---- dependencies 里加/改一条
            var depPattern = new Regex("(\"dependencies\"\\s*:\\s*\\{)([\\s\\S]*?)(\\})");
            var depMatch = depPattern.Match(result);
            if (!depMatch.Success)
            {
                throw new InvalidOperationException(
                    "profile 的 package.json 里找不到 \"dependencies\" 对象，无法登记插件。");
            }

            var depValue = "file:" + pluginDir.Replace('\\', '/');
            var depKey = "\"" + pluginName + "\"";
            var depBody = depMatch.Groups[2].Value;
            var existing = new Regex(Regex.Escape(depKey) + "\\s*:\\s*\"[^\"]*\"");
            if (existing.IsMatch(depBody))
            {
                depBody = existing.Replace(depBody, depKey + ": \"" + depValue + "\"", 1);
            }
            else
            {
                var trimmed = depBody.TrimEnd();
                var sep = (trimmed.Length == 0 || trimmed.EndsWith("{")) ? "" : ",";
                depBody = trimmed + sep + Environment.NewLine + "    " + depKey +
                          ": \"" + depValue + "\"" + Environment.NewLine + "  ";
            }
            result = result.Substring(0, depMatch.Groups[2].Index) + depBody +
                     result.Substring(depMatch.Groups[2].Index + depMatch.Groups[2].Length);

            // ---- dsh.profile.bundles 里加一项
            var bundlesPattern = new Regex("(\"bundles\"\\s*:\\s*\\[)([\\s\\S]*?)(\\])");
            var bMatch = bundlesPattern.Match(result);
            if (!bMatch.Success)
            {
                throw new InvalidOperationException(
                    "profile 的 package.json 里找不到 dsh.profile.bundles 数组，无法登记插件。");
            }
            var body = bMatch.Groups[2].Value;
            if (!new Regex("\"" + Regex.Escape(pluginName) + "\"").IsMatch(body))
            {
                var t = body.TrimEnd();
                var add = (t.Length == 0 ? "" : ", ") + "\"" + pluginName + "\"";
                body = t + add + "  ";
            }
            result = result.Substring(0, bMatch.Groups[2].Index) + body +
                     result.Substring(bMatch.Groups[2].Index + bMatch.Groups[2].Length);

            return result;
        }
    }

    // ================================================================ 自检
    /**
     * `--selftest <目标目录>`：只做"解压载荷"并逐项核对。
     *
     * 为什么需要：载荷解压是**本项目自己实现的**（MiniZip.cs，为兼容 .NET 4.0
     * 不能用 ZipFile）。自己写的解析器最需要被验证，而 GUI 模式既要点鼠标、
     * 又会真的改 DSH 配置，不适合反复跑。有了这个模式，解压逻辑就能在
     * 临时目录上自动验证。
     */
    internal static class SelfTest
    {
        internal static int Run(string target)
        {
            var failures = 0;
            /*
             * 报告同时写进内存（最后落盘）与标准输出。
             *
             * 为什么还要落盘：本程序是 `/target:winexe`（GUI 子系统），
             * **父控制台看不到它的 stdout** —— 直接跑 `setup.exe --selftest`
             * 在 PowerShell 里不会打印任何东西。写文件让调用方一定能拿到结果。
             */
            var report = new StringBuilder();
            Action<string> emit = delegate(string line)
            {
                Console.WriteLine(line);
                report.AppendLine(line);
            };

            Action<string, bool, string> check = delegate(string name, bool ok, string detail)
            {
                emit("  " + (ok ? "[PASS] " : "[FAIL] ") + name + (detail != null ? "  " + detail : ""));
                if (!ok) failures++;
            };

            emit("载荷解压自检");
            emit("  目标：" + target);

            var payload = Payload.Bytes;
            check("取到内嵌载荷", payload != null,
                payload == null
                    ? "资源名 'payload' 取不到 —— 构建时没内嵌？"
                    : (payload.Length / 1024 / 1024) + " MB");
            if (payload == null)
            {
                WriteReport(report, target);
                return 1;
            }

            try
            {
                if (Directory.Exists(target)) Directory.Delete(target, true);
            }
            catch
            {
                // 忽略：解压会覆盖
            }

            var count = 0;
            try
            {
                count = new MiniZip().ExtractAll(payload, target, null);
            }
            catch (Exception ex)
            {
                check("解压不抛异常", false, ex.GetType().Name + ": " + ex.Message);
                WriteReport(report, target);
                return 1;
            }
            check("解压不抛异常", true, count + " 个文件");

            /* 关键文件逐个核对：缺任何一个插件都装不起来。 */
            var required = new[]
            {
                "package.json",
                "cordis.patch.yml",
                "install.mjs",
                "src/host/index.js",
                "client/client.js",
                "pet-app/main.js",
                "assets/animations/stand/manifest.json",
            };
            foreach (var rel in required)
            {
                var full = Path.Combine(target, rel.Replace('/', Path.DirectorySeparatorChar));
                var ok = File.Exists(full);
                check("含 " + rel, ok, ok ? new FileInfo(full).Length + " 字节" : "缺失");
            }

            /* 依赖树最容易漏，缺它 DSH 会报 failed to import。 */
            var nm = Path.Combine(target, "node_modules");
            check("含依赖树 node_modules/", Directory.Exists(nm), null);
            check("含 @deepseek-ai/schemastery",
                File.Exists(Path.Combine(nm, "@deepseek-ai", "schemastery", "package.json")), null);

            /*
             * 素材：关键动作目录必须在。
             *
             * ⚠️ 刻意**不**写死"目录数 = 某个数字"。
             * 原先断言 `animCount == 10`，于是每加一个动作（坐下就加了 3 个目录）
             * 这条都会假失败 —— 而它想守的其实是"素材没被打包漏掉"。
             */
            var animRoot = Path.Combine(target, "assets", "animations");
            var animCount = Directory.Exists(animRoot) ? Directory.GetDirectories(animRoot).Length : 0;
            var requiredAnims = new[]
            {
                "stand", "hang", "eat", "sleep", "awake",
                "head", "chest", "stomach", "leg", "play-mc",
                "sit", "sit-circle", "sit-stop",
            };
            var missingAnims = "";
            foreach (var a in requiredAnims)
            {
                if (!Directory.Exists(Path.Combine(animRoot, a)))
                {
                    missingAnims += (missingAnims.Length == 0 ? "" : ", ") + a;
                }
            }
            check("关键动画动作目录都在", missingAnims.Length == 0,
                missingAnims.Length == 0 ? "共 " + animCount + " 个目录，关键目录齐全" : "缺：" + missingAnims);
            check("动画动作目录数不少于 10", animCount >= 10, "实际 " + animCount);

            /*
             * 二进制抽查：帧文件必须是**完整的 WebP**（RIFF....WEBP）。
             *
             * 素材已从 PNG 换成 WebP（体积只有 ~20%，alpha 无损，见
             * scripts/dev/compress-assets.py）。这条检查的作用是抓
             * "解压把二进制弄坏"——换格式不该把检查丢掉。
             */
            var frame = Path.Combine(animRoot, "stand", "frame_01.webp");
            if (File.Exists(frame))
            {
                var head = File.ReadAllBytes(frame);
                var okWebp = head.Length > 12
                    && head[0] == 0x52 && head[1] == 0x49 && head[2] == 0x46 && head[3] == 0x46   /* RIFF */
                    && head[8] == 0x57 && head[9] == 0x45 && head[10] == 0x42 && head[11] == 0x50; /* WEBP */
                check("WebP 文件头正确（二进制未被损坏）", okWebp,
                    okWebp ? head.Length + " 字节" : "头部不是 WebP 签名");
            }
            else
            {
                check("WebP 文件头正确（二进制未被损坏）", false, "找不到 stand/frame_01.webp");
            }

            emit("");
            emit(failures == 0 ? "自检通过。" : "自检有 " + failures + " 项失败。");
            WriteReport(report, target);
            return failures == 0 ? 0 : 1;
        }

        /**
         * 把报告写到**目标目录的旁边**（目标目录本身会被解压内容占满）。
         *
         * ⚠️ 不要写 `%TEMP%`：在受沙箱约束的环境里对它的写入会被拒，
         * 于是"自检失败"连原因都看不到 —— 这个坑我踩了一轮。
         * 写在目标目录的父目录，既有写权限，调用方也容易读到。
         */
        private static void WriteReport(StringBuilder report, string target)
        {
            var tried = new List<string>();
            try
            {
                var parent = Path.GetDirectoryName(target.TrimEnd(Path.DirectorySeparatorChar));
                if (!string.IsNullOrEmpty(parent))
                {
                    Directory.CreateDirectory(parent);
                    var path = Path.Combine(parent, "setup-selftest-report.txt");
                    tried.Add(path);
                    File.WriteAllText(path, report.ToString(), new UTF8Encoding(false));
                    Console.WriteLine("（报告已写入 " + path + "）");
                    return;
                }
            }
            catch (Exception ex)
            {
                tried.Add("(失败：" + ex.Message + ")");
            }
            try
            {
                var path = Path.Combine(Path.GetTempPath(), "dsh-pet-setup-selftest.txt");
                tried.Add(path);
                File.WriteAllText(path, report.ToString(), new UTF8Encoding(false));
                Console.WriteLine("（报告已写入 " + path + "）");
                return;
            }
            catch (Exception ex)
            {
                tried.Add("(失败：" + ex.Message + ")");
            }
            Console.WriteLine("（报告写入失败，试过：" + string.Join(" | ", tried.ToArray()) + "）");
        }
    }
}
