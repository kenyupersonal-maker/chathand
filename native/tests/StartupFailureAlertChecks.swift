import AppKit

@main struct StartupFailureAlertChecks {
    static func main() throws {
        _=NSApplication.shared
        let args=CommandLine.arguments
        let catalogs=URL(fileURLWithPath:args[1]),language=args[2],status=Int32(args[3])!,scheme=args[4]
        let text=(try JSONSerialization.jsonObject(with:Data(contentsOf:catalogs.appendingPathComponent(language+".json")))) as! [String:String]
        let code=NativeDiagnostics.startupFailureCode(reason:.exit,status:status)!
        NSApp.appearance=NSAppearance(named:scheme == "dark" ? .darkAqua:.aqua)
        let (alert,actions)=StartupFailureAlert.make(code:code,canRetry:true,text:{text[$0] ?? $0})
        precondition(alert.informativeText.contains("("+code+")"))
        precondition(alert.informativeText.contains(text["native.startupFailure."+StartupFailureAlert.reason(code)]!))
        precondition(alert.buttons.count == actions.count)
        for (button,action) in zip(alert.buttons,actions) {precondition(button.title==text["native.startupFailure.action."+action.rawValue])}
        let first=actions.first!
        switch status {
        case 71: precondition(first == .download)
        case 72,74,75,76,82...90: precondition(first == .dataFolder)
        default: precondition(first == .retry)
        }
        if args.count>5 {
            let window=alert.window
            window.appearance=NSApp.appearance
            // NSAlert installs its final controls when its modal session starts.
            // Keep this synthetic window invisible and render only its own view.
            window.alphaValue=0
            var captureError: Error?
            DispatchQueue.main.asyncAfter(deadline:.now()+0.1) {
                window.setFrameOrigin(NSPoint(x:-10000,y:-10000))
                window.alphaValue=1
                window.layoutIfNeeded()
                let content=window.contentView!
                content.layoutSubtreeIfNeeded()
                // AppKit's modern alert labels use layers; the print drawing
                // path includes those controls in an offscreen bitmap.
                let drawing=NSImage(data:content.dataWithPDF(inside:content.bounds))!
                let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:Int(content.bounds.width*2),pixelsHigh:Int(content.bounds.height*2),bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
                bitmap.size=content.bounds.size
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:bitmap)
                NSColor.windowBackgroundColor.setFill();content.bounds.fill()
                drawing.draw(in:content.bounds)
                // Glass buttons are omitted by AppKit's print pass. Draw the
                // real cells at their finished native layout positions.
                for button in alert.buttons {button.cell?.draw(withFrame:button.convert(button.bounds,to:content),in:content)}
                NSGraphicsContext.restoreGraphicsState()
                do {try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:args[5]))}
                catch {captureError=error}
                NSApp.abortModal()
            }
            _=alert.runModal();window.orderOut(nil)
            if let captureError {throw captureError}
        }
        print("PASS: "+code+" "+actions.map{$0.rawValue}.joined(separator:","))
    }
}
