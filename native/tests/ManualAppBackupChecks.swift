import Foundation
@main struct ManualAppBackupChecks {
 static func main() throws {
  let a=CommandLine.arguments,home=URL(fileURLWithPath:a[1]),app=home.appendingPathComponent("Applications/ChatHand.app"),state=home.appendingPathComponent("Library/Application Support/ChatHand/data")
  let plan=try ChatHandUninstallPlan(app:app,home:home,state:state,deleteData:a[2]=="delete",incremental:true),lease=try plan.excludeUpgrade();var events:[[String:String]]=[]
  let report=plan.executeStages(backendStopped:true,loginRemoved:true,exclusion:lease,event:{events.append(["stage":$0,"code":$1])})
  let rows=report.items.map {["stage":$0.stage,"code":$0.code,"remaining":$0.remaining,"preserved":$0.preserved] as [String:Any]}
  let data=try JSONSerialization.data(withJSONObject:["complete":report.complete,"items":rows,"events":events],options:[.sortedKeys]);print(String(data:data,encoding:.utf8)!)
 }
}
