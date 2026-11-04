// Windows agent-mode backend script: a long-lived PowerShell that compiles a tiny C# wrapper
// around user32!SendInput and then answers one command per stdin line with one result line.
// No native build needed; spawned with -EncodedCommand so stdin stays free for commands.
//
// Protocol (ASCII only — free text travels as base64):
//   ping                         → ok
//   move <ax> <ay>               ax/ay: MOUSEEVENTF_ABSOLUTE|VIRTUALDESK coords (0..65535)
//   click <ax> <ay> left|right <count>
//   scroll <ax> <ay> <dy> <dx>   lines; +dy = down, +dx = right
//   type <base64 utf-8>
//   key <vk>,<vk>,…              press order; vk | 0x100 = extended key
// Replies: "ok" or "err <message>". Prints "ready" once the type is compiled.

const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ClickityInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  const uint MOVE = 0x1, LDOWN = 0x2, LUP = 0x4, RDOWN = 0x8, RUP = 0x10, WHEEL = 0x800, HWHEEL = 0x1000, VIRTUALDESK = 0x4000, ABSOLUTE = 0x8000;
  const uint EXTENDED = 0x1, KEYUP = 0x2, UNICODE = 0x4;

  public static void Init() {
    // per-monitor v2 (-4): everything this process sees is in physical pixels
    try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
    catch (Exception) { try { SetProcessDPIAware(); } catch (Exception) { } }
  }

  static INPUT Mouse(int x, int y, uint flags, int data) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dx = x; i.u.mi.dy = y; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i;
  }
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i;
  }
  static void Send(INPUT[] a) {
    if (a.Length == 0) return;
    uint n = SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));
    if (n != a.Length) throw new Exception("input was blocked (is the target app running as admin?)");
  }
  static void Send1(INPUT i) { Send(new INPUT[] { i }); }

  static void Move(int x, int y) { Send1(Mouse(x, y, MOVE | ABSOLUTE | VIRTUALDESK, 0)); }

  static void Click(int x, int y, bool right, int count) {
    Move(x, y); Thread.Sleep(30);
    if (count < 1) count = 1; if (count > 3) count = 3;
    for (int n = 0; n < count; n++) {
      Send1(Mouse(0, 0, right ? RDOWN : LDOWN, 0)); Thread.Sleep(15);
      Send1(Mouse(0, 0, right ? RUP : LUP, 0));
      if (n + 1 < count) Thread.Sleep(60);
    }
  }

  static void Scroll(int x, int y, int dy, int dx) {
    Move(x, y); Thread.Sleep(30);
    if (dy != 0) Send1(Mouse(0, 0, WHEEL, -120 * dy));   // wheel: + = away from the user (up)
    if (dx != 0) Send1(Mouse(0, 0, HWHEEL, 120 * dx));   // hwheel: + = right
  }

  static void VkTap(List<INPUT> l, ushort vk) {
    ushort sc = (ushort)MapVirtualKey(vk, 0);
    l.Add(Key(vk, sc, 0)); l.Add(Key(vk, sc, KEYUP));
  }

  static void Type(string text) {
    List<INPUT> l = new List<INPUT>();
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') { VkTap(l, 0x0D); continue; }
      if (c == '\t') { VkTap(l, 0x09); continue; }
      l.Add(Key(0, c, UNICODE)); l.Add(Key(0, c, UNICODE | KEYUP));
    }
    for (int i = 0; i < l.Count; i += 40) {
      Send(l.GetRange(i, Math.Min(40, l.Count - i)).ToArray());
      Thread.Sleep(10);
    }
  }

  static void Chord(int[] vks) {
    List<INPUT> down = new List<INPUT>();
    List<INPUT> up = new List<INPUT>();
    foreach (int v in vks) {
      ushort vk = (ushort)(v & 0xFF);
      uint ext = (v & 0x100) != 0 ? EXTENDED : 0;
      ushort sc = (ushort)MapVirtualKey(vk, 0);
      down.Add(Key(vk, sc, ext));
      up.Insert(0, Key(vk, sc, ext | KEYUP));
    }
    try { foreach (INPUT i in down) { Send1(i); Thread.Sleep(8); } }
    finally { foreach (INPUT i in up) { try { Send1(i); } catch (Exception) { } Thread.Sleep(8); } }
  }

  static int I(string s) { return int.Parse(s, NumberStyles.Integer, CultureInfo.InvariantCulture); }

  public static string Run(string line) {
    try {
      string[] p = line.Split(' ');
      switch (p[0]) {
        case "ping": break;
        case "move": Move(I(p[1]), I(p[2])); break;
        case "click": Click(I(p[1]), I(p[2]), p[3] == "right", I(p[4])); break;
        case "scroll": Scroll(I(p[1]), I(p[2]), I(p[3]), I(p[4])); break;
        case "type": Type(Encoding.UTF8.GetString(Convert.FromBase64String(p[1]))); break;
        case "key": Chord(Array.ConvertAll(p[1].Split(','), new Converter<string, int>(I))); break;
        default: return "err unknown command";
      }
      return "ok";
    } catch (Exception e) {
      return "err " + e.Message.Replace("\r", " ").Replace("\n", " ");
    }
  }
}
`;

export const WIN_INPUT_SCRIPT = `$ErrorActionPreference = 'Stop'
$src = @'
${CSHARP.trim()}
'@
Add-Type -TypeDefinition $src -Language CSharp
[ClickityInput]::Init()
$rd = [Console]::In
$wr = [Console]::Out
$wr.WriteLine('ready'); $wr.Flush()
while ($true) {
  $line = $rd.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  $wr.WriteLine([ClickityInput]::Run($line)); $wr.Flush()
}
`;

/** powershell.exe arguments: the script travels as UTF-16LE base64, so stdin is only commands. */
export function winPowershellArgs(): string[] {
  return [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(WIN_INPUT_SCRIPT, 'utf16le').toString('base64'),
  ];
}
