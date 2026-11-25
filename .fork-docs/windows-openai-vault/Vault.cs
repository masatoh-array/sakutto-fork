using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static class Vault
{
    private static readonly Regex ExtensionOrigin =
        new Regex(@"\Achrome-extension://([a-p]{32})/\z", RegexOptions.CultureInvariant);
    private static readonly Regex SlotName =
        new Regex(@"\A[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\z", RegexOptions.CultureInvariant);
    private static readonly Regex KeyFormat =
        new Regex(@"\A[!-~]{1,1024}\z", RegexOptions.CultureInvariant);
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer
    {
        MaxJsonLength = 8192,
        RecursionLimit = 8
    };

    public static void Main(string[] args)
    {
        object result;
        try
        {
            // Chrome also checks allowed_origins before it launches this process.
            var origin = ExtensionOrigin.Match(args.Length > 0 ? args[0] : "");
            if (!origin.Success) throw new InvalidDataException();
            var input = Console.OpenStandardInput();
            var length = new byte[4];
            ReadExact(input, length);
            int count = BitConverter.ToInt32(length, 0);
            if (count < 2 || count > 8192) throw new InvalidDataException();
            var request = new byte[count];
            ReadExact(input, request);
            try
            {
                result = Execute(origin.Groups[1].Value, Json.Deserialize<Dictionary<string, string>>(Utf8.GetString(request)));
            }
            finally
            {
                Array.Clear(request, 0, request.Length);
            }
        }
        catch
        {
            // Never print errors, incoming JSON, paths, or secrets to stdout/stderr.
            result = new { ok = false };
        }
        try
        {
            var resultBytes = Utf8.GetBytes(Json.Serialize(result));
            try
            {
                var output = Console.OpenStandardOutput();
                output.Write(BitConverter.GetBytes(resultBytes.Length), 0, 4);
                output.Write(resultBytes, 0, resultBytes.Length);
                output.Flush();
            }
            finally
            {
                Array.Clear(resultBytes, 0, resultBytes.Length);
            }
        }
        catch { }
    }

    private static object Execute(string extensionId, Dictionary<string, string> request)
    {
        string op, slot;
        if (request == null ||
            !request.TryGetValue("operation", out op) || !request.TryGetValue("slot", out slot) ||
            slot == null || !SlotName.IsMatch(slot)) throw new InvalidDataException();
        if (request.Count != (op == "save" ? 3 : 2)) throw new InvalidDataException();

        var root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrEmpty(root)) throw new IOException();
        var dir = Path.Combine(root, "Sakutto", "OpenAI", extensionId);
        var path = Path.Combine(dir, slot + ".bin");
        var purpose = Utf8.GetBytes("Sakutto.OpenAI.v1:" + extensionId + ":" + slot);
        switch (op)
        {
            case "has":
                return new { ok = true, present = Read(path, purpose).Length != 0 };
            case "read":
                return new { ok = true, key = Read(path, purpose) };
            case "remove":
                try { File.Delete(path); }
                catch (DirectoryNotFoundException) { }
                return new { ok = true };
            case "save":
                string key;
                if (!request.TryGetValue("key", out key) || key == null || !KeyFormat.IsMatch(key))
                    throw new InvalidDataException();
                var plain = Utf8.GetBytes(key);
                byte[] cipher;
                try
                {
                    cipher = ProtectedData.Protect(plain, purpose, DataProtectionScope.CurrentUser);
                }
                finally
                {
                    Array.Clear(plain, 0, plain.Length);
                }
                Directory.CreateDirectory(dir);
                var pending = Path.Combine(dir, Guid.NewGuid().ToString("N") + ".tmp");
                try
                {
                    using (var file = new FileStream(pending, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        file.Write(cipher, 0, cipher.Length);
                        file.Flush(true);
                    }
                    if (File.Exists(path)) File.Replace(pending, path, null);
                    else File.Move(pending, path);
                }
                finally
                {
                    File.Delete(pending);
                }
                return new { ok = true };
            default:
                throw new InvalidDataException();
        }
    }

    private static string Read(string path, byte[] purpose)
    {
        byte[] encrypted;
        try
        {
            using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete))
            {
                if (file.Length < 1 || file.Length > 16384) throw new InvalidDataException();
                encrypted = new byte[(int)file.Length];
                ReadExact(file, encrypted);
            }
        }
        catch (FileNotFoundException) { return ""; }
        catch (DirectoryNotFoundException) { return ""; }
        var plain = ProtectedData.Unprotect(encrypted, purpose, DataProtectionScope.CurrentUser);
        try
        {
            var key = Utf8.GetString(plain);
            if (!KeyFormat.IsMatch(key)) throw new InvalidDataException();
            return key;
        }
        finally
        {
            Array.Clear(plain, 0, plain.Length);
        }
    }

    private static void ReadExact(Stream stream, byte[] buffer)
    {
        int offset = 0;
        while (offset < buffer.Length)
        {
            int n = stream.Read(buffer, offset, buffer.Length - offset);
            if (n == 0) throw new EndOfStreamException();
            offset += n;
        }
    }
}
