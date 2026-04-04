#include "ghostty_bridge.h"

#include <ghostty/vt.h>

struct AdhdevGhosttyTerminal {
    GhosttyTerminal handle;
    uint16_t cols;
    uint16_t rows;
};

static const uint32_t kCellWidthPx = 8;
static const uint32_t kCellHeightPx = 16;

int adhdev_ghostty_terminal_create(
    uint16_t cols,
    uint16_t rows,
    size_t scrollback,
    AdhdevGhosttyTerminal** out_terminal) {
    if (!out_terminal || cols == 0 || rows == 0) return GHOSTTY_INVALID_VALUE;

    AdhdevGhosttyTerminal* terminal = (AdhdevGhosttyTerminal*)ghostty_alloc(NULL, sizeof(AdhdevGhosttyTerminal));
    if (!terminal) return GHOSTTY_OUT_OF_MEMORY;

    terminal->cols = cols;
    terminal->rows = rows;
    terminal->handle = NULL;

    GhosttyTerminalOptions options = {
        .cols = cols,
        .rows = rows,
        .max_scrollback = scrollback,
    };

    GhosttyResult result = ghostty_terminal_new(NULL, &terminal->handle, options);
    if (result != GHOSTTY_SUCCESS) {
        ghostty_free(NULL, (uint8_t*)terminal, sizeof(AdhdevGhosttyTerminal));
        return result;
    }

    *out_terminal = terminal;
    return GHOSTTY_SUCCESS;
}

int adhdev_ghostty_terminal_write(
    AdhdevGhosttyTerminal* terminal,
    const uint8_t* data,
    size_t len) {
    if (!terminal || !terminal->handle || (!data && len > 0)) return GHOSTTY_INVALID_VALUE;
    ghostty_terminal_vt_write(terminal->handle, data, len);
    return GHOSTTY_SUCCESS;
}

int adhdev_ghostty_terminal_resize(
    AdhdevGhosttyTerminal* terminal,
    uint16_t cols,
    uint16_t rows) {
    if (!terminal || !terminal->handle || cols == 0 || rows == 0) return GHOSTTY_INVALID_VALUE;
    terminal->cols = cols;
    terminal->rows = rows;
    (void)kCellWidthPx;
    (void)kCellHeightPx;
    return ghostty_terminal_resize(terminal->handle, cols, rows);
}

int adhdev_ghostty_terminal_format_plain_text(
    AdhdevGhosttyTerminal* terminal,
    int trim,
    char** out_text,
    size_t* out_len) {
    if (!terminal || !terminal->handle || !out_text || !out_len) return GHOSTTY_INVALID_VALUE;

    GhosttyFormatterTerminalOptions options = GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalOptions);
    options.emit = GHOSTTY_FORMATTER_FORMAT_PLAIN;
    options.trim = trim != 0;

    GhosttyFormatter formatter = NULL;
    GhosttyResult result = ghostty_formatter_terminal_new(NULL, &formatter, terminal->handle, options);
    if (result != GHOSTTY_SUCCESS) return result;

    uint8_t* text = NULL;
    size_t text_len = 0;
    result = ghostty_formatter_format_alloc(formatter, NULL, &text, &text_len);
    ghostty_formatter_free(formatter);
    if (result != GHOSTTY_SUCCESS) return result;

    *out_text = (char*)text;
    *out_len = text_len;
    return GHOSTTY_SUCCESS;
}

int adhdev_ghostty_terminal_format_vt(
    AdhdevGhosttyTerminal* terminal,
    char** out_text,
    size_t* out_len) {
    if (!terminal || !terminal->handle || !out_text || !out_len) return GHOSTTY_INVALID_VALUE;

    GhosttyFormatterTerminalOptions options = GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalOptions);
    options.emit = GHOSTTY_FORMATTER_FORMAT_VT;
    options.unwrap = false;
    options.trim = false;
    options.extra.palette = true;
    options.extra.modes = true;
    options.extra.scrolling_region = true;
    options.extra.tabstops = true;
    options.extra.keyboard = true;
    options.extra.screen.cursor = true;
    options.extra.screen.style = true;
    options.extra.screen.hyperlink = true;
    options.extra.screen.protection = true;
    options.extra.screen.kitty_keyboard = true;
    options.extra.screen.charsets = true;

    GhosttyFormatter formatter = NULL;
    GhosttyResult result = ghostty_formatter_terminal_new(NULL, &formatter, terminal->handle, options);
    if (result != GHOSTTY_SUCCESS) return result;

    uint8_t* text = NULL;
    size_t text_len = 0;
    result = ghostty_formatter_format_alloc(formatter, NULL, &text, &text_len);
    ghostty_formatter_free(formatter);
    if (result != GHOSTTY_SUCCESS) return result;

    *out_text = (char*)text;
    *out_len = text_len;
    return GHOSTTY_SUCCESS;
}

int adhdev_ghostty_terminal_cursor_position(
    AdhdevGhosttyTerminal* terminal,
    uint16_t* out_col,
    uint16_t* out_row) {
    if (!terminal || !terminal->handle || !out_col || !out_row) return GHOSTTY_INVALID_VALUE;

    GhosttyResult result = ghostty_terminal_get(
        terminal->handle,
        GHOSTTY_TERMINAL_DATA_CURSOR_X,
        out_col);
    if (result != GHOSTTY_SUCCESS) return result;

    result = ghostty_terminal_get(
        terminal->handle,
        GHOSTTY_TERMINAL_DATA_CURSOR_Y,
        out_row);
    if (result != GHOSTTY_SUCCESS) return result;

    return GHOSTTY_SUCCESS;
}

void adhdev_ghostty_terminal_free_text(char* text, size_t len) {
    if (!text) return;
    ghostty_free(NULL, (uint8_t*)text, len);
}

void adhdev_ghostty_terminal_destroy(AdhdevGhosttyTerminal* terminal) {
    if (!terminal) return;
    if (terminal->handle) {
        ghostty_terminal_free(terminal->handle);
        terminal->handle = NULL;
    }
    ghostty_free(NULL, (uint8_t*)terminal, sizeof(AdhdevGhosttyTerminal));
}

const char* adhdev_ghostty_result_message(int result) {
    switch (result) {
        case GHOSTTY_SUCCESS:
            return "success";
        case GHOSTTY_OUT_OF_MEMORY:
            return "out of memory";
        case GHOSTTY_INVALID_VALUE:
            return "invalid value";
        case GHOSTTY_OUT_OF_SPACE:
            return "out of space";
        default:
            return "unknown error";
    }
}
