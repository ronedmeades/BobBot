' Bob Launcher - silent wrapper
' Runs launcher.cmd without a visible console window flash.
' This is what the desktop shortcut points to.

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\.."
WshShell.Run "cmd /c scripts\launcher.cmd", 0, False
