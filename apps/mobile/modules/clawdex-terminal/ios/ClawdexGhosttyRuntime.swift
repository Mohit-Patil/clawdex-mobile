import Foundation

#if canImport(GhosttyVt)
import GhosttyVt
#endif

struct ClawdexGhosttyRendererInfo {
  let available: Bool
  let backend: String
  let message: String

  func asDictionary(sessionId: String? = nil) -> [String: Any] {
    var payload: [String: Any] = [
      "available": available,
      "backend": backend,
      "message": message,
    ]

    if let sessionId {
      payload["sessionId"] = sessionId
    } else {
      payload["sessionId"] = NSNull()
    }

    return payload
  }
}

struct ClawdexGhosttyTextSnapshot {
  let text: String
  let cursorX: Int
  let cursorY: Int
  let cursorVisible: Bool
}

final class ClawdexGhosttyRuntime {
  static let unavailableInfo = ClawdexGhosttyRendererInfo(
    available: false,
    backend: "ios-placeholder",
    message:
      "Build and vend `ghostty-vt.xcframework` to enable the native libghostty-vt renderer."
  )

  #if canImport(GhosttyVt)
  static let availableInfo = ClawdexGhosttyRendererInfo(
    available: true,
    backend: "ghostty-vt-render-state",
    message: "libghostty-vt is linked and providing render-state snapshots natively."
  )
  #endif

  static var rendererInfo: ClawdexGhosttyRendererInfo {
    #if canImport(GhosttyVt)
    availableInfo
    #else
    unavailableInfo
    #endif
  }

  private(set) var cols: Int
  private(set) var rows: Int

  #if canImport(GhosttyVt)
  private var terminal: GhosttyTerminal?
  private var renderState: GhosttyRenderState?
  #endif

  init(cols: Int, rows: Int) {
    self.cols = max(cols, 1)
    self.rows = max(rows, 1)
    #if canImport(GhosttyVt)
    createTerminal()
    #endif
  }

  deinit {
    #if canImport(GhosttyVt)
    if let renderState {
      ghostty_render_state_free(renderState)
    }
    if let terminal {
      ghostty_terminal_free(terminal)
    }
    #endif
  }

  func resize(cols: Int, rows: Int, pixelWidth: Int = 0, pixelHeight: Int = 0) {
    self.cols = max(cols, 1)
    self.rows = max(rows, 1)

    #if canImport(GhosttyVt)
    guard let terminal else {
      createTerminal()
      return
    }

    ghostty_terminal_resize(
      terminal,
      UInt16(self.cols),
      UInt16(self.rows),
      UInt32(max(pixelWidth, 0)),
      UInt32(max(pixelHeight, 0))
    )
    #endif
  }

  func write(base64: String) -> ClawdexGhosttyTextSnapshot? {
    #if canImport(GhosttyVt)
    guard let terminal, let data = Data(base64Encoded: base64), !data.isEmpty else {
      return snapshot()
    }

    data.withUnsafeBytes { bytes in
      guard let baseAddress = bytes.bindMemory(to: UInt8.self).baseAddress else {
        return
      }
      ghostty_terminal_vt_write(terminal, baseAddress, data.count)
    }

    return snapshot()
    #else
    return nil
    #endif
  }

  func snapshot() -> ClawdexGhosttyTextSnapshot? {
    #if canImport(GhosttyVt)
    guard let terminal else {
      return nil
    }

    var options = GhosttyFormatterTerminalOptions()
    options.size = MemoryLayout<GhosttyFormatterTerminalOptions>.size
    options.emit = GHOSTTY_FORMATTER_FORMAT_PLAIN
    options.trim = false

    var formatter: GhosttyFormatter?
    let formatterResult = ghostty_formatter_terminal_new(nil, &formatter, terminal, options)
    guard formatterResult == GHOSTTY_SUCCESS, let formatter else {
      return nil
    }
    defer {
      ghostty_formatter_free(formatter)
    }

    var buffer: UnsafeMutablePointer<UInt8>?
    var length = 0
    let allocResult = ghostty_formatter_format_alloc(formatter, nil, &buffer, &length)
    guard allocResult == GHOSTTY_SUCCESS else {
      if let buffer {
        ghostty_free(nil, buffer, length)
      }
      return nil
    }

    guard let buffer else {
      return ClawdexGhosttyTextSnapshot(
        text: "",
        cursorX: cursorViewportX,
        cursorY: cursorViewportY,
        cursorVisible: cursorVisible
      )
    }
    defer {
      ghostty_free(nil, buffer, length)
    }

    if length == 0 {
      return ClawdexGhosttyTextSnapshot(
        text: "",
        cursorX: cursorViewportX,
        cursorY: cursorViewportY,
        cursorVisible: cursorVisible
      )
    }

    let data = Data(bytes: buffer, count: length)
    guard let text = String(data: data, encoding: .utf8) else {
      return nil
    }

    return ClawdexGhosttyTextSnapshot(
      text: text,
      cursorX: cursorViewportX,
      cursorY: cursorViewportY,
      cursorVisible: cursorVisible
    )
    #else
    return nil
    #endif
  }

  #if canImport(GhosttyVt)
  private var cursorVisible: Bool {
    guard let renderState = updatedRenderState() else {
      return false
    }

    var cursorVisible = false
    var cursorInViewport = false
    guard
      ghostty_render_state_get(
        renderState,
        GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE,
        &cursorVisible
      ) == GHOSTTY_SUCCESS,
      ghostty_render_state_get(
        renderState,
        GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE,
        &cursorInViewport
      ) == GHOSTTY_SUCCESS
    else {
      return false
    }

    return cursorVisible && cursorInViewport
  }

  private var cursorViewportX: Int {
    guard let renderState = updatedRenderState() else {
      return 0
    }

    var value: UInt16 = 0
    guard
      ghostty_render_state_get(
        renderState,
        GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X,
        &value
      ) == GHOSTTY_SUCCESS
    else {
      return 0
    }

    return Int(value)
  }

  private var cursorViewportY: Int {
    guard let renderState = updatedRenderState() else {
      return 0
    }

    var value: UInt16 = 0
    guard
      ghostty_render_state_get(
        renderState,
        GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y,
        &value
      ) == GHOSTTY_SUCCESS
    else {
      return 0
    }

    return Int(value)
  }

  private func updatedRenderState() -> GhosttyRenderState? {
    guard let terminal else {
      return nil
    }

    if renderState == nil {
      var nextRenderState: GhosttyRenderState?
      guard ghostty_render_state_new(nil, &nextRenderState) == GHOSTTY_SUCCESS else {
        return nil
      }
      renderState = nextRenderState
    }

    guard let renderState else {
      return nil
    }

    guard ghostty_render_state_update(renderState, terminal) == GHOSTTY_SUCCESS else {
      return nil
    }

    return renderState
  }

  private func createTerminal() {
    if let terminal {
      ghostty_terminal_free(terminal)
      self.terminal = nil
    }

    if let renderState {
      ghostty_render_state_free(renderState)
      self.renderState = nil
    }

    var nextTerminal: GhosttyTerminal?
    let options = GhosttyTerminalOptions(
      cols: UInt16(cols),
      rows: UInt16(rows),
      max_scrollback: 10_000
    )
    let result = ghostty_terminal_new(nil, &nextTerminal, options)
    guard result == GHOSTTY_SUCCESS else {
      return
    }

    terminal = nextTerminal
    if let terminal {
      ghostty_terminal_resize(terminal, UInt16(cols), UInt16(rows), 0, 0)
    }
  }
  #endif
}
