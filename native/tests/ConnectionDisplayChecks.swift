import Foundation
@main struct ConnectionDisplayChecks {
 static func main(){
  for (state,title,connected) in [("up","已连接",true),("checking","云端没回应，正在确认",false),("down","连不上",false),("unknown","本机正常，云端未核验",false)] {
   let display:[String:Any] = ["state":state,"title":title,"connected":connected]
   var snapshot:[String:Any] = ["enabled":true,"connection":["ready":true,"healthy":true,"display":display]]
   let menu=MenuBarState(snapshot:snapshot);precondition(menu.connectionTitle==title && menu.isConnected==connected)
   snapshot["relay"]=["online":true];precondition(MenuBarState(snapshot:snapshot).connectionTitle=="ChatGPT 已连接")
  }
  let legacy=MenuBarState(snapshot:["enabled":true,"connection":["ready":true,"healthy":true]])
  precondition(legacy.isConnected)
  print("C2 native display: 9 checks PASS")
 }
}
