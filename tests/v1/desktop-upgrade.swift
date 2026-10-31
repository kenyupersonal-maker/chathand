import Cocoa
import ApplicationServices

// Pure tests only. Do not invoke execute/status/target/Session or any OS permission,
// AX tree, screenshot, clipboard, key/mouse, foreground, or notification path.
@main struct DesktopRuleChecks {
    @MainActor static func main() async {
        var checks = 0
        func expect(_ passed: Bool, _ message: String) {
            checks += 1
            if !passed { fputs("FAIL \(message)\n",stderr); exit(1) }
        }
        let frame = CGRect(x:-1000,y:100,width:1000,height:500)
        for (role,name,liveRole,liveName,enabled,wanted) in [
            ("AXButton","按钮","AXButton","按钮",true,nil),
            ("AXButton","按钮","AXButton","改名",true,"COMPUTER_ELEMENT_STALE"),
            ("AXButton","按钮","AXTextField","按钮",true,"COMPUTER_ELEMENT_STALE"),
            ("AXButton","按钮","AXButton","按钮",false,"COMPUTER_ELEMENT_DISABLED")
        ] as [(String,String,String,String,Bool,String?)] {
            expect(ComputerControl.elementProblem(expectedRole:role,expectedName:name,liveRole:liveRole,liveName:liveName,enabled:enabled,frame:frame)==wanted,"AX identity table")
        }
        for (bundle,pid,window,expected) in [("a.app",1,UInt64(1),false),("b.app",1,UInt64(1),true),("a.app",2,UInt64(1),true),("a.app",1,UInt64(2),true)] {
            let issue=ComputerControl.windowContextProblem(expectedBundle:"a.app",expectedPID:1,expectedWindowToken:1,actualBundle:bundle,actualPID:pid_t(pid),actualWindowToken:window)
            expect((issue != nil)==expected,"window/process table")
        }
        var presses=0
        expect(ComputerControl.semanticPress(supported:false,perform:{presses+=1;return .success}) == .unavailable,"unsupported AXPress")
        expect(presses==0,"unsupported never dispatches")
        expect(ComputerControl.semanticPress(supported:true,perform:{presses+=1;return .cannotComplete}) == .unconfirmed,"uncertain AXPress")
        expect(presses==1,"uncertain press attempted once")
        for (settable,result,read,wanted,calls) in [
            (false,AXError.success,"中文😄",ComputerControl.AXTextResult.unavailable,0),
            (true,AXError.success,"中文😄",ComputerControl.AXTextResult.verified,1),
            (true,AXError.cannotComplete,"中文😄",ComputerControl.AXTextResult.unconfirmed,1),
            (true,AXError.success,"文字不一样",ComputerControl.AXTextResult.unconfirmed,1)
        ] {
            var writes=0
            let actual=ComputerControl.axTextResult(settable:settable,set:{writes+=1;return result},read:{read},expected:"中文😄")
            expect(actual==wanted,"AXValue verify table")
            expect(writes==calls,"AXValue never repeats on uncertain result")
        }
        let pixels=ComputerControl.imageRect(CGRect(x:-750,y:200,width:250,height:100),window:frame,width:2000,height:1000)
        expect(pixels==CGRect(x:500,y:200,width:500,height:200),"Retina negative-origin transform")
        let ocr=ComputerControl.ocrRect(CGRect(x:0.25,y:0.6,width:0.25,height:0.2),window:frame)
        expect(abs(ocr.minY-200)<0.001 && ocr.minX == -750 && ocr.width == 250,"OCR bottom-left to screen top-left")
        expect(!ComputerControl.framesMatch(frame,frame.offsetBy(dx:10,dy:0)),"moving window makes coordinates stale")
        for name in ["密码","验证码","one-time code","Private Key"] { expect(ComputerControl.sensitiveName(name),"sensitive text table") }
        for name in ["发送","提交","付款","Log in"] { expect(ComputerControl.consequentialName(name),"consequential action table") }
        expect(ComputerControl.securityProblem(bundle:"com.apple.SecurityAgent",title:""),"system authentication manual")
        expect(!ComputerControl.securityProblem(bundle:"com.apple.systempreferences",title:"隐私与安全性"),"ordinary privacy setting allowed")
        expect(!ComputerControl.securityProblem(bundle:"com.apple.systempreferences",title:"外观"),"ordinary nonsecurity setting allowed")
        expect(ComputerControl.keySpec("Command+V") != nil,"supported key syntax")
        expect(ComputerControl.keySpec("Hyper+V") == nil,"unknown modifier rejected")
        expect(ComputerControl.keySpec("not-a-key") == nil,"unknown key rejected")
        expect(!ComputerControl.inputAllowedForBundle("com.kenyu.chathand",selfBundleID:nil),"cannot change ChatHand through desktop input")
        expect(!ComputerControl.inputAllowedForBundle("test.bridge",selfBundleID:"test.bridge"),"development bundle self protection")
        expect(ComputerControl.inputAllowedForBundle("test.editor",selfBundleID:"test.bridge"),"ordinary target App allowed")
        for (token,live,stopped,deadline,wanted) in [(1,1,false,11.0,true),(1,2,false,11.0,false),(1,1,true,11.0,false),(1,1,false,10.0,false)] {
            expect(ComputerControl.requestIsCurrent(token:UInt64(token),liveGeneration:UInt64(live),stopped:stopped,deadline:deadline,now:10)==wanted,"stop/generation/deadline table")
        }
        for (currentPID,currentWindow,originalAvailable,used,wanted) in [
            (2,UInt64(7),true,true,true),(3,UInt64(7),true,true,false),
            (2,UInt64(8),true,true,false),(2,UInt64(7),false,true,false),
            (2,UInt64(7),true,false,false)
        ] {
            expect(ComputerControl.shouldRestoreForeground(targetPID:2,currentPID:pid_t(currentPID),
                   targetWindowToken:7,currentWindowToken:currentWindow,originalAvailable:originalAvailable,
                   usedForeground:used)==wanted,"restore only the exact borrowed window and available original")
        }
        for failureIndex in [nil,0,1] as [Int?] {
            var invoked: [Int] = []
            let output = try! await ComputerControl.runBatch((0..<3).map { ["step_id":"step-\($0)","index":$0] }) { step in
                let index=step["index"] as! Int; invoked.append(index)
                if index==failureIndex { throw ComputerControl.ControlFailure("COMPUTER_ACTION_UNCONFIRMED","fixture",uncertain:true) }
                return ["performed":"fixture"]
            }
            let receipts=output["receipts"] as! [[String:Any]]
            expect(invoked.count==(failureIndex.map { $0+1 } ?? 3),"batch stops before next step")
            expect(receipts.count==3,"every step has a receipt including not attempted")
            expect((output["completed"] as! Bool)==(failureIndex==nil),"batch outcome table")
            if let failureIndex { expect(receipts.last?["status"] as? String == "not_attempted" && receipts[failureIndex]["status"] as? String == "failed_or_unconfirmed","uncertain step never replayed") }
        }
        print("PASS \(checks) pure desktop rule checks; no OS control paths executed")
    }
}
