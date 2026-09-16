' Wrapper for Windows Task Scheduler.
'
' Why this exists: if the scheduled task launches node.exe directly, Windows
' allocates a console window that flashes on screen every single run. Running
' node through WScript.Shell.Run with window style 0 is the only reliable way
' to keep it fully hidden.
'
' Output goes to sync.log next to this file. sync.js is invoked with --quiet,
' so a run that changes nothing writes nothing at all and the log stays a
' clean audit trail of actual changes.
'
' NOTE: comments here are intentionally ASCII. wscript parses .vbs as ANSI
' unless the file is UTF-16 with a BOM, so non-ASCII comments would be mojibake.

Option Explicit

Dim fso, here, root, sh, logFile, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)
logFile = here & "\sync.log"

' Cheap log rotation: roll over once past 1 MB so it never grows unbounded.
If fso.FileExists(logFile) Then
    If fso.GetFile(logFile).Size > 1048576 Then
        If fso.FileExists(logFile & ".1") Then
            fso.DeleteFile logFile & ".1", True
        End If
        fso.MoveFile logFile, logFile & ".1"
    End If
End If

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root

cmd = "cmd /c node """ & here & "\sync.js"" --quiet >> """ & logFile & """ 2>&1"
sh.Run cmd, 0, False
