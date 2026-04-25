import ExpoModulesCore

public class ClawdexTerminalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ClawdexTerminal")

    Function("getRendererInfo") {
      ClawdexGhosttyRuntime.rendererInfo.asDictionary()
    }

    View(ClawdexTerminalView.self) {
      Prop("sessionId") { (view: ClawdexTerminalView, sessionId: String?) in
        view.sessionId = sessionId
      }

      Prop("cols") { (view: ClawdexTerminalView, cols: Int) in
        view.setGrid(cols: cols, rows: view.rows)
      }

      Prop("rows") { (view: ClawdexTerminalView, rows: Int) in
        view.setGrid(cols: view.cols, rows: rows)
      }

      Prop("writeFrame") { (view: ClawdexTerminalView, frame: [String: Any]?) in
        view.applyWriteFrame(frame)
      }

      Prop("placeholderText") { (view: ClawdexTerminalView, placeholderText: String?) in
        view.placeholderText = placeholderText ?? view.placeholderText
      }

      Events("onReady", "onInput", "onTerminalResize")
    }
  }
}
