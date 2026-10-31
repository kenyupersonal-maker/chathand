import AppKit
let args = CommandLine.arguments
 guard args.count == 3, let icon = NSImage(contentsOfFile: args[1]) else { fputs("Help icon input missing\n", stderr); exit(2) }
guard NSWorkspace.shared.setIcon(icon, forFile: args[2], options: []) else { fputs("Help icon could not be applied\n", stderr); exit(1) }
