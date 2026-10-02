/*
 * project-graph-ownership-helper —— Node/Windows 侧的**等价实现**（C# 源码，按需编译）。
 *
 * ── 它是什么、为什么需要它 ──────────────────────────────────────────────
 * Project Graph 的 CLI（`tool invoke`）在动手前要先拿到目标 `.prg` 的**独占所有权**：
 * 它 spawn 一个原生 helper（`app/src-tauri/src/bin/project-graph-ownership-helper.rs`），
 * 按下面这份行协议对话。上游把这份 helper 放在 Rust/Tauri 侧，本机没有可用的
 * 目标原生产物，所以这里按**同一份协议**重写一份：源码入库，运行前用系统自带的
 * `csc.exe` 编译成 exe（见 host 半段 pgHelperPath / ensurePgHelper）。
 *
 * ── 协议（逐条对齐上游 bin 的 serde 形状）────────────────────────────────
 *   调用：<helper> try-hold-project <canonical .prg 路径>
 *   成功：stdout 写 **一行** `{"status":"acquired","canonicalPath":"<协议串>"}\n`，
 *         然后**阻塞到 stdin 关闭**，释放锁，退出码 0。
 *         除这一行外**不许有任何 stdout 输出** —— 上层 `rejectAdditionalOutput()`
 *         见到第二个块就判定 INVALID_RESPONSE。
 *   被占：`{"status":"busy","owner":{"kind":"unconnectable_holder"}}` + `\n`，退出码 **75**。
 *   失败：`{"status":"error","code":"PROJECT_NOT_FOUND"}`（文件不在）
 *         或 `{"status":"error","code":"PROJECT_LOAD_FAILED"}`（不是 .prg / 读不动），
 *         退出码 **1**。
 *   用法错：`{"status":"error","code":"HELPER_USAGE_ERROR"}`，退出码 2。
 *
 * ── 锁与键（对齐 `project_ownership.rs`）─────────────────────────────────
 *   锁目录：`PROJECT_GRAPH_OWNERSHIP_DIRECTORY`，缺省 `%APPDATA%\liren.project-graph\project-ownership`
 *           （`dirs::data_dir()` 在 Windows 上就是 %APPDATA%）。
 *   键    ：`sha256_hex( utf16le(协议串) )`；协议串 = 去掉 `\\?\` 前缀的规范路径
 *           （`\\?\UNC\` → `\\`）。
 *   锁文件：`<锁目录>\<键>.lock`。
 *
 * ── 另外两条命令：项目级引用（`n1` / `e1` 这套稳定句柄）的存与取 ──────────────
 *   CLI 的 closed-project 路径在调用前后各要一次（`OwnershipHelper.ts` 的
 *   `loadProjectReferences` / `saveProjectReferences`）——**不做这两条，CLI 会直接
 *   报 `OWNERSHIP_HELPER_INVALID_RESPONSE`**（它拿到 usage error 时不认）。
 *
 *   调用：<helper> load-project-references <项目 URI> [<旧项目 URI>]
 *         stdout 一行 `{"status":"loaded","snapshot":<快照|null>}`，退出码 0；
 *         失败 `{"status":"error","code":"REFERENCE_STORE_LOAD_FAILED"}` + 退出码 1。
 *   调用：<helper> save-project-references <项目 URI>      （快照 JSON 从 **stdin** 读）
 *         stdout 一行 `{"status":"saved"}`，退出码 0；
 *         失败 `{"status":"error","code":"REFERENCE_STORE_SAVE_FAILED"}` + 退出码 1。
 *
 *   存储（对齐 `project_reference_store.rs`）：
 *     文件：`PROJECT_GRAPH_REFERENCE_STORE_PATH`，缺省
 *           `%APPDATA%\liren.project-graph\ai-project-references.json`
 *     锁  ：同目录 `<文件名>.lock`
 *     形状：`{ "project:<URI>:references": { "version":1, "references": <快照>, "updatedAt": <ms> }, … }`
 *           —— **同一个文件里别的键原样保留**（那是别人写的，不是我们的地盘）。
 *     快照：`{ "entries":[{"ref":"n1","uuid":"…"}], "nextNodeRef":N, "nextEdgeRef":M }`；
 *           `ref` 须形如 `n1` / `e1`（首位非 0）、uuid 非空、ref 与 uuid 各自不许重复，
 *           `nextNodeRef` / `nextEdgeRef` 都 ≥ 1。
 *     落盘：先写同目录临时文件再改名（原子），不留半截文件。
 *
 *   ⚠️ 与上游的差异：① 上游的 `migrate_legacy_store`（macOS 遗留目录）这里不做 ——
 *      Windows 上那个路径是 `%USERPROFILE%\Library\Application Support\…`，不存在；
 *      ② 上游用 `lock()` 阻塞等锁，这里用 `FileShare.None` + 有限次重试。
 *
 * ── 与上游 Rust 版的**已知差异**（诚实清单，不许当成等价）────────────────
 *   上游用 `File::try_lock()`（LockFileEx 字节区间锁），锁文件**永久留在盘上**；
 *   这里用 `FileShare.None` 打开同一个文件。两者对**自己人**互斥都成立，
 *   但对**彼此**不互斥：若真机同时跑着桌面版（Rust helper），两边可能都认为
 *   自己持有。本机未装桌面版，且本实现的用途是"防同一台机器上两次 CLI 调用撞车"，
 *   所以按此实现；要完全对齐请构建上游原生 helper 并用
 *   `PROJECT_GRAPH_OWNERSHIP_HELPER_PATH` 指过去。
 *
 * 语言级别：C# 5（`csc.exe` v4.0.30319 能编）—— 不用字符串插值、不用表达式体成员。
 * JSON：`JavaScriptSerializer`（`System.Web.Extensions.dll`，.NET Framework 自带），
 *       所以编译命令必须带 `/r:System.Web.Extensions.dll`。
 */

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class ProjectGraphOwnershipHelper
{
    private const string OwnershipDirectoryVariable = "PROJECT_GRAPH_OWNERSHIP_DIRECTORY";
    private const string ReferenceStoreVariable = "PROJECT_GRAPH_REFERENCE_STORE_PATH";
    private const string AppIdentifier = "liren.project-graph";
    private const string OwnershipDirectoryName = "project-ownership";
    private const string ReferenceStoreFileName = "ai-project-references.json";
    private const int BusyExitCode = 75;

    private static int Main(string[] args)
    {
        // 上游 bin 只认这几条；其余一律 HELPER_USAGE_ERROR。
        if (args.Length == 2 && (args[0] == "try-hold-project" || args[0] == "hold-project"))
        {
            return HoldProject(args[1]);
        }
        if (args.Length == 2 && args[0] == "load-project-references")
        {
            return LoadProjectReferences(args[1], null);
        }
        if (args.Length == 3 && args[0] == "load-project-references")
        {
            return LoadProjectReferences(args[1], args[2]);
        }
        if (args.Length == 2 && args[0] == "save-project-references")
        {
            return SaveProjectReferences(args[1]);
        }
        return UsageError();
    }

    private static int HoldProject(string rawPath)
    {
        if (String.IsNullOrEmpty(rawPath))
        {
            return UsageError();
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(rawPath);
        }
        catch (Exception)
        {
            return ErrorResponse("PROJECT_LOAD_FAILED", 1);
        }

        if (!File.Exists(fullPath))
        {
            return ErrorResponse("PROJECT_NOT_FOUND", 1);
        }

        string extension = Path.GetExtension(fullPath);
        if (!String.Equals(extension, ".prg", StringComparison.OrdinalIgnoreCase))
        {
            return ErrorResponse("PROJECT_LOAD_FAILED", 1);
        }

        string protocolPath = ToProtocolString(fullPath);
        string key = OwnershipKey(protocolPath);
        string directory = OwnershipDirectory();

        FileStream lockFile;
        try
        {
            Directory.CreateDirectory(directory);
            string lockPath = Path.Combine(directory, key + ".lock");
            // FileShare.None = 同一时刻只有一个进程能拿住这个文件（进程死掉由 OS 释放）。
            lockFile = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException)
        {
            return BusyResponse();
        }
        catch (UnauthorizedAccessException)
        {
            return BusyResponse();
        }
        catch (Exception)
        {
            return ErrorResponse("PROJECT_LOAD_FAILED", 1);
        }

        try
        {
            WriteLine("{\"status\":\"acquired\",\"canonicalPath\":" + JsonString(protocolPath) + "}");
        }
        catch (Exception)
        {
            lockFile.Dispose();
            return 1;
        }

        try
        {
            // 阻塞到 stdin 关闭 —— 上层 `OwnershipHelperLease.release()` 就是 end() stdin。
            using (Stream stdin = Console.OpenStandardInput())
            {
                byte[] buffer = new byte[256];
                while (stdin.Read(buffer, 0, buffer.Length) > 0)
                {
                    // 上游同样把 stdin 内容丢掉：它不是命令通道，只是"我还活着"的握手。
                }
            }
        }
        catch (Exception)
        {
            // stdin 断了也算正常收工。
        }

        lockFile.Dispose();
        return 0;
    }

    /** `\\?\UNC\srv\share` → `\\srv\share`；`\\?\C:\x` → `C:\x`（对齐 Rust 的 to_protocol_string）。 */
    private static string ToProtocolString(string fullPath)
    {
        if (fullPath.StartsWith(@"\\?\UNC\", StringComparison.Ordinal))
        {
            return @"\\" + fullPath.Substring(8);
        }
        if (fullPath.StartsWith(@"\\?\", StringComparison.Ordinal))
        {
            return fullPath.Substring(4);
        }
        return fullPath;
    }

    /** `sha256_hex(utf16le(协议串))` —— 与 Rust 侧 ownership_key 逐字节一致。 */
    private static string OwnershipKey(string protocolPath)
    {
        UnicodeEncoding utf16 = new UnicodeEncoding(false, false);
        byte[] bytes = utf16.GetBytes(protocolPath);
        byte[] digest;
        using (SHA256 sha = SHA256.Create())
        {
            digest = sha.ComputeHash(bytes);
        }
        StringBuilder builder = new StringBuilder(digest.Length * 2);
        for (int index = 0; index < digest.Length; index++)
        {
            builder.Append(digest[index].ToString("x2", CultureInfo.InvariantCulture));
        }
        return builder.ToString();
    }

    private static string OwnershipDirectory()
    {
        string configured = Environment.GetEnvironmentVariable(OwnershipDirectoryVariable);
        if (!String.IsNullOrEmpty(configured))
        {
            return configured;
        }
        return Path.Combine(
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), AppIdentifier),
            OwnershipDirectoryName);
    }

    /* ── 项目级引用存储（`n1` / `e1` 这套稳定句柄）────────────────────────── */

    private static string ReferenceStorePath()
    {
        string configured = Environment.GetEnvironmentVariable(ReferenceStoreVariable);
        if (!String.IsNullOrEmpty(configured))
        {
            return configured;
        }
        return Path.Combine(
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), AppIdentifier),
            ReferenceStoreFileName);
    }

    /** 当前进程号（走 `Process` 而不是 `Environment.ProcessId` —— 后者是 .NET 5+ 才有的）。 */
    private static int CurrentProcessId()
    {
        return System.Diagnostics.Process.GetCurrentProcess().Id;
    }

    private static string ReferenceKey(string projectUri)
    {
        return "project:" + projectUri + ":references";
    }

    private static JavaScriptSerializer NewSerializer()
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        serializer.MaxJsonLength = Int32.MaxValue;
        serializer.RecursionLimit = 200;
        return serializer;
    }

    /** 读整张存储表；文件不存在 = 空表（不是错误）。 */
    private static Dictionary<string, object> ReadStore(string path)
    {
        Dictionary<string, object> empty = new Dictionary<string, object>();
        if (!File.Exists(path))
        {
            return empty;
        }
        string text = File.ReadAllText(path, Encoding.UTF8);
        if (text.Trim().Length == 0)
        {
            return empty;
        }
        object parsed;
        try
        {
            parsed = NewSerializer().DeserializeObject(text);
        }
        catch (Exception)
        {
            throw new InvalidDataException("Project Object Reference store is not valid JSON.");
        }
        Dictionary<string, object> map = parsed as Dictionary<string, object>;
        if (map == null)
        {
            throw new InvalidDataException("Project Object Reference store is not a JSON object.");
        }
        return map;
    }

    /** 同目录临时文件 + 改名（原子落盘；不留半截文件）。 */
    private static void WriteStoreAtomically(string path, Dictionary<string, object> store)
    {
        string parent = Path.GetDirectoryName(path);
        if (String.IsNullOrEmpty(parent))
        {
            throw new InvalidDataException("Project Object Reference store path has no directory.");
        }
        Directory.CreateDirectory(parent);
        string temporary = Path.Combine(
            parent,
            "." + Path.GetFileName(path) + "." + CurrentProcessId().ToString(CultureInfo.InvariantCulture)
                + "." + Guid.NewGuid().ToString("N") + ".tmp");
        File.WriteAllText(temporary, NewSerializer().Serialize(store), new UTF8Encoding(false));
        if (File.Exists(path))
        {
            try
            {
                File.Replace(temporary, path, null);
                return;
            }
            catch (Exception)
            {
                // 某些卷上 `File.Replace` 不可用 —— 退回到"删掉再改名"。
            }
            File.Delete(path);
        }
        File.Move(temporary, path);
    }

    /**
     * 存储表上的跨进程锁。上游用阻塞 `lock()`，这里用 `FileShare.None` + 有限次重试：
     * 拿不到就抛，由调用方翻成 REFERENCE_STORE_*_FAILED（与上游"拿不到锁即失败"同形）。
     */
    private static FileStream AcquireStoreLock(string path)
    {
        string lockPath = path + ".lock";
        string parent = Path.GetDirectoryName(lockPath);
        if (!String.IsNullOrEmpty(parent))
        {
            Directory.CreateDirectory(parent);
        }
        Exception last = null;
        for (int attempt = 0; attempt < 100; attempt++)
        {
            try
            {
                return new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            }
            catch (Exception error)
            {
                last = error;
                Thread.Sleep(50);
            }
        }
        throw new IOException("Project Object Reference store lock is unavailable.", last);
    }

    private static long AsLong(object value)
    {
        if (value == null)
        {
            throw new InvalidDataException("expected a number");
        }
        if (value is int) { return (int)value; }
        if (value is long) { return (long)value; }
        if (value is decimal) { return (long)(decimal)value; }
        if (value is double) { return (long)(double)value; }
        if (value is string)
        {
            long parsed;
            if (Int64.TryParse((string)value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
            {
                return parsed;
            }
        }
        throw new InvalidDataException("expected a number");
    }

    private static bool IsObjectReference(string reference)
    {
        if (String.IsNullOrEmpty(reference) || reference.Length < 2)
        {
            return false;
        }
        char head = reference[0];
        if (head != 'n' && head != 'e')
        {
            return false;
        }
        string number = reference.Substring(1);
        if (number.Length == 0 || number[0] == '0')
        {
            return false;
        }
        for (int index = 0; index < number.Length; index++)
        {
            if (number[index] < '0' || number[index] > '9')
            {
                return false;
            }
        }
        return true;
    }

    /** 校验并规范化一份快照 —— 与 Rust 的 `validate_snapshot` 逐条对齐。 */
    private static Dictionary<string, object> CanonicalizeSnapshot(object value)
    {
        Dictionary<string, object> snapshot = value as Dictionary<string, object>;
        if (snapshot == null)
        {
            throw new InvalidDataException("snapshot is not a JSON object");
        }
        long nextNodeRef = AsLong(GetMember(snapshot, "nextNodeRef"));
        long nextEdgeRef = AsLong(GetMember(snapshot, "nextEdgeRef"));
        if (nextNodeRef < 1 || nextEdgeRef < 1)
        {
            throw new InvalidDataException("snapshot counters must be at least 1");
        }
        object[] rawEntries = GetMember(snapshot, "entries") as object[];
        if (rawEntries == null)
        {
            throw new InvalidDataException("snapshot entries is not an array");
        }
        List<object> entries = new List<object>(rawEntries.Length);
        HashSet<string> references = new HashSet<string>(StringComparer.Ordinal);
        HashSet<string> uuids = new HashSet<string>(StringComparer.Ordinal);
        for (int index = 0; index < rawEntries.Length; index++)
        {
            Dictionary<string, object> entry = rawEntries[index] as Dictionary<string, object>;
            if (entry == null)
            {
                throw new InvalidDataException("snapshot entry is not a JSON object");
            }
            string reference = GetMember(entry, "ref") as string;
            string uuid = GetMember(entry, "uuid") as string;
            if (reference == null || uuid == null || uuid.Length == 0 || !IsObjectReference(reference))
            {
                throw new InvalidDataException("snapshot entry is invalid");
            }
            if (!references.Add(reference) || !uuids.Add(uuid))
            {
                throw new InvalidDataException("snapshot entry is duplicated");
            }
            Dictionary<string, object> canonical = new Dictionary<string, object>();
            canonical["ref"] = reference;
            canonical["uuid"] = uuid;
            entries.Add(canonical);
        }
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["entries"] = entries.ToArray();
        result["nextNodeRef"] = nextNodeRef;
        result["nextEdgeRef"] = nextEdgeRef;
        return result;
    }

    private static object GetMember(Dictionary<string, object> map, string key)
    {
        object value;
        return map.TryGetValue(key, out value) ? value : null;
    }

    /** 存储里的一条（`{version,references,updatedAt,…}`）→ 快照。 */
    private static Dictionary<string, object> DecodeSnapshot(object stored)
    {
        Dictionary<string, object> entry = stored as Dictionary<string, object>;
        if (entry == null)
        {
            throw new InvalidDataException("stored snapshot is not a JSON object");
        }
        object version = GetMember(entry, "version");
        if (version == null || AsLong(version) != 1)
        {
            throw new InvalidDataException("stored snapshot version is unsupported");
        }
        return CanonicalizeSnapshot(GetMember(entry, "references"));
    }

    private static int LoadProjectReferences(string projectUri, string legacyProjectUri)
    {
        FileStream storeLock = null;
        try
        {
            string path = ReferenceStorePath();
            storeLock = AcquireStoreLock(path);
            Dictionary<string, object> store = ReadStore(path);
            object stored = null;
            bool found = store.TryGetValue(ReferenceKey(projectUri), out stored);
            if (!found && legacyProjectUri != null && legacyProjectUri != projectUri)
            {
                found = store.TryGetValue(ReferenceKey(legacyProjectUri), out stored);
            }
            string payload = "null";
            if (found && stored != null)
            {
                payload = NewSerializer().Serialize(DecodeSnapshot(stored));
            }
            WriteLine("{\"status\":\"loaded\",\"snapshot\":" + payload + "}");
            return 0;
        }
        catch (Exception)
        {
            return ErrorResponse("REFERENCE_STORE_LOAD_FAILED", 1);
        }
        finally
        {
            if (storeLock != null)
            {
                storeLock.Dispose();
            }
        }
    }

    private static int SaveProjectReferences(string projectUri)
    {
        FileStream storeLock = null;
        try
        {
            Dictionary<string, object> canonical = CanonicalizeSnapshot(
                NewSerializer().DeserializeObject(ReadAllStdin()));
            string path = ReferenceStorePath();
            storeLock = AcquireStoreLock(path);
            Dictionary<string, object> store = ReadStore(path);
            string key = ReferenceKey(projectUri);
            object existing;
            if (store.TryGetValue(key, out existing) && existing != null)
            {
                DecodeSnapshot(existing);   // 既有的坏数据不许被静默覆盖
            }
            Dictionary<string, object> entry = new Dictionary<string, object>();
            entry["version"] = 1;
            entry["references"] = canonical;
            entry["updatedAt"] = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            store[key] = entry;
            WriteStoreAtomically(path, store);
            WriteLine("{\"status\":\"saved\"}");
            return 0;
        }
        catch (Exception)
        {
            return ErrorResponse("REFERENCE_STORE_SAVE_FAILED", 1);
        }
        finally
        {
            if (storeLock != null)
            {
                storeLock.Dispose();
            }
        }
    }

    /** 把 stdin 读到 EOF（save 的快照 JSON 就从这里来）。 */
    private static string ReadAllStdin()
    {
        using (StreamReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)))
        {
            return reader.ReadToEnd();
        }
    }

    private static int BusyResponse()
    {
        WriteLine("{\"status\":\"busy\",\"owner\":{\"kind\":\"unconnectable_holder\"}}");
        return BusyExitCode;
    }

    private static int ErrorResponse(string code, int exitCode)
    {
        WriteLine("{\"status\":\"error\",\"code\":" + JsonString(code) + "}");
        return exitCode;
    }

    private static int UsageError()
    {
        WriteLine("{\"status\":\"error\",\"code\":\"HELPER_USAGE_ERROR\"}");
        return 2;
    }

    /** 一行 JSON 到 stdout —— **只此一行**，多一个字节上层就判 INVALID_RESPONSE。 */
    private static void WriteLine(string line)
    {
        Stream stdout = Console.OpenStandardOutput();
        byte[] payload = new UTF8Encoding(false).GetBytes(line + "\n");
        stdout.Write(payload, 0, payload.Length);
        stdout.Flush();
    }

    /** 最小 JSON 字符串转义（路径只需要反斜杠、引号与控制字符这几条）。 */
    private static string JsonString(string value)
    {
        StringBuilder builder = new StringBuilder(value.Length + 2);
        builder.Append('"');
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            if (character == '"')
            {
                builder.Append("\\\"");
            }
            else if (character == '\\')
            {
                builder.Append("\\\\");
            }
            else if (character < ' ')
            {
                builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
            }
            else
            {
                builder.Append(character);
            }
        }
        builder.Append('"');
        return builder.ToString();
    }
}
