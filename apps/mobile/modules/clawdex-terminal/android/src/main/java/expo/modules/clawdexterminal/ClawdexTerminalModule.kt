package expo.modules.clawdexterminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ClawdexTerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ClawdexTerminal")

    Function("getRendererInfo") {
      mapOf(
        "available" to false,
        "backend" to "android-placeholder",
        "message" to "Android is still using the placeholder renderer while iOS libghostty-vt work is wired up."
      )
    }

    View(ClawdexTerminalView::class) {
      Prop("sessionId") { view: ClawdexTerminalView, sessionId: String? ->
        view.sessionId = sessionId
      }

      Prop("cols") { view: ClawdexTerminalView, cols: Int ->
        view.setGrid(cols, view.rows)
      }

      Prop("rows") { view: ClawdexTerminalView, rows: Int ->
        view.setGrid(view.cols, rows)
      }

      Prop("writeFrame") { view: ClawdexTerminalView, frame: Map<String, Any?>? ->
        view.applyWriteFrame(frame)
      }

      Prop("placeholderText") { view: ClawdexTerminalView, placeholderText: String? ->
        view.placeholderText = placeholderText ?: view.placeholderText
      }

      Events("onReady", "onInput", "onTerminalResize")
    }
  }
}
