#include "ghostty_bridge.h"

#include <ghostty/vt.h>

#include <stdlib.h>
#include <string.h>

struct AdhdevGhosttyTerminal {
    GhosttyTerminal handle;
    uint16_t cols;
    uint16_t rows;
    // Bumped on every mutation (write/resize/scroll) so a reader can tell
    // whether two reads describe the same terminal state.
    uint64_t revision;
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
    terminal->revision = 0;

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
    terminal->revision++;
    ghostty_terminal_vt_write(terminal->handle, data, len);
    return GHOSTTY_SUCCESS;
}

int adhdev_ghostty_terminal_resize(
    AdhdevGhosttyTerminal* terminal,
    uint16_t cols,
    uint16_t rows) {
    if (!terminal || !terminal->handle || cols == 0 || rows == 0) return GHOSTTY_INVALID_VALUE;
    terminal->revision++;
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

// Growable byte buffer for the deep copies below. Everything handed out of
// this file is plain malloc memory owned by the caller; no GridRef or page
// pointer outlives the call that resolved it.
typedef struct {
    char* data;
    size_t len;
    size_t cap;
} ByteBuffer;

static int byte_buffer_reserve(ByteBuffer* buffer, size_t extra) {
    if (buffer->len + extra <= buffer->cap) return GHOSTTY_SUCCESS;
    size_t cap = buffer->cap ? buffer->cap : 64;
    while (cap < buffer->len + extra) cap *= 2;
    char* data = (char*)realloc(buffer->data, cap);
    if (!data) return GHOSTTY_OUT_OF_MEMORY;
    buffer->data = data;
    buffer->cap = cap;
    return GHOSTTY_SUCCESS;
}

static int byte_buffer_append_codepoint(ByteBuffer* buffer, uint32_t cp) {
    // Surrogates and out-of-range values cannot be encoded as UTF-8.
    if ((cp >= 0xD800 && cp <= 0xDFFF) || cp > 0x10FFFF) cp = 0xFFFD;
    int result = byte_buffer_reserve(buffer, 4);
    if (result != GHOSTTY_SUCCESS) return result;
    char* out = buffer->data + buffer->len;
    if (cp < 0x80) {
        out[0] = (char)cp;
        buffer->len += 1;
    } else if (cp < 0x800) {
        out[0] = (char)(0xC0 | (cp >> 6));
        out[1] = (char)(0x80 | (cp & 0x3F));
        buffer->len += 2;
    } else if (cp < 0x10000) {
        out[0] = (char)(0xE0 | (cp >> 12));
        out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        out[2] = (char)(0x80 | (cp & 0x3F));
        buffer->len += 3;
    } else {
        out[0] = (char)(0xF0 | (cp >> 18));
        out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
        out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
        out[3] = (char)(0x80 | (cp & 0x3F));
        buffer->len += 4;
    }
    return GHOSTTY_SUCCESS;
}

static int resolve_ref(GhosttyTerminal handle, GhosttyPointTag tag, uint16_t x, uint16_t y, GhosttyGridRef* out_ref) {
    GhosttyPoint point;
    memset(&point, 0, sizeof(point));
    point.tag = tag;
    point.value.coordinate.x = x;
    point.value.coordinate.y = y;
    *out_ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
    return ghostty_terminal_grid_ref(handle, point, out_ref);
}

void adhdev_ghostty_row_data_release(AdhdevGhosttyRowData* row) {
    if (!row) return;
    free(row->text);
    free(row->cells);
    free(row->cell_text);
    memset(row, 0, sizeof(*row));
}

// Reads physical row `y` of `tag` cell by cell. Row text keeps an empty cell
// that sits before real content as U+0020 (so cursor-forward gaps survive) and
// drops only the trailing run of content-less cells; spacer cells contribute
// nothing because their glyph belongs to the wide cell that owns them.
static int read_row_internal(
    GhosttyTerminal handle,
    GhosttyPointTag tag,
    uint16_t y,
    uint16_t cols,
    int include_cells,
    AdhdevGhosttyRowData* out_row) {
    memset(out_row, 0, sizeof(*out_row));
    out_row->row = y;

    GhosttyGridRef ref;
    int result = resolve_ref(handle, tag, 0, y, &ref);
    if (result != GHOSTTY_SUCCESS) return result;

    GhosttyRow row_value = 0;
    result = ghostty_grid_ref_row(&ref, &row_value);
    if (result != GHOSTTY_SUCCESS) return result;
    bool wrapped = false;
    bool wrap_continuation = false;
    result = ghostty_row_get(row_value, GHOSTTY_ROW_DATA_WRAP, &wrapped);
    if (result != GHOSTTY_SUCCESS) return result;
    result = ghostty_row_get(row_value, GHOSTTY_ROW_DATA_WRAP_CONTINUATION, &wrap_continuation);
    if (result != GHOSTTY_SUCCESS) return result;
    out_row->wrapped = wrapped;
    out_row->wrap_continuation = wrap_continuation;

    ByteBuffer text = {0};
    ByteBuffer cell_text = {0};
    AdhdevGhosttyCellInfo* cells = NULL;
    uint32_t inline_codepoints[16];
    uint32_t* codepoints = inline_codepoints;
    size_t codepoint_cap = sizeof(inline_codepoints) / sizeof(inline_codepoints[0]);
    size_t content_end = 0;

    if (include_cells) {
        cells = (AdhdevGhosttyCellInfo*)calloc(cols ? cols : 1, sizeof(AdhdevGhosttyCellInfo));
        if (!cells) {
            result = GHOSTTY_OUT_OF_MEMORY;
            goto fail;
        }
    }

    for (uint16_t x = 0; x < cols; x++) {
        result = resolve_ref(handle, tag, x, y, &ref);
        if (result != GHOSTTY_SUCCESS) goto fail;

        GhosttyCell cell = 0;
        result = ghostty_grid_ref_cell(&ref, &cell);
        if (result != GHOSTTY_SUCCESS) goto fail;
        GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
        result = ghostty_cell_get(cell, GHOSTTY_CELL_DATA_WIDE, &wide);
        if (result != GHOSTTY_SUCCESS) goto fail;

        size_t count = 0;
        result = ghostty_grid_ref_graphemes(&ref, codepoints, codepoint_cap, &count);
        if (result == GHOSTTY_OUT_OF_SPACE) {
            // Never truncate a grapheme cluster: grow to the reported length.
            uint32_t* grown = (uint32_t*)malloc(count * sizeof(uint32_t));
            if (!grown) {
                result = GHOSTTY_OUT_OF_MEMORY;
                goto fail;
            }
            if (codepoints != inline_codepoints) free(codepoints);
            codepoints = grown;
            codepoint_cap = count;
            result = ghostty_grid_ref_graphemes(&ref, codepoints, codepoint_cap, &count);
        }
        if (result != GHOSTTY_SUCCESS) goto fail;

        const bool spacer = wide == GHOSTTY_CELL_WIDE_SPACER_TAIL || wide == GHOSTTY_CELL_WIDE_SPACER_HEAD;
        if (cells) {
            cells[x].wide = (uint8_t)wide;
            cells[x].text_offset = (uint32_t)cell_text.len;
        }
        if (spacer) {
            if (cells) cells[x].text_len = 0;
            continue;
        }
        if (count == 0) {
            if (cells) cells[x].text_len = 0;
            result = byte_buffer_reserve(&text, 1);
            if (result != GHOSTTY_SUCCESS) goto fail;
            text.data[text.len++] = ' ';
            continue;
        }
        for (size_t i = 0; i < count; i++) {
            result = byte_buffer_append_codepoint(&text, codepoints[i]);
            if (result != GHOSTTY_SUCCESS) goto fail;
            if (cells) {
                result = byte_buffer_append_codepoint(&cell_text, codepoints[i]);
                if (result != GHOSTTY_SUCCESS) goto fail;
            }
        }
        content_end = text.len;
        if (cells) cells[x].text_len = (uint32_t)(cell_text.len - cells[x].text_offset);
    }

    if (codepoints != inline_codepoints) free(codepoints);
    out_row->text = text.data;
    out_row->text_len = content_end;
    out_row->cells = cells;
    out_row->cell_count = cells ? cols : 0;
    out_row->cell_text = cell_text.data;
    out_row->cell_text_len = cell_text.len;
    return GHOSTTY_SUCCESS;

fail:
    if (codepoints != inline_codepoints) free(codepoints);
    free(text.data);
    free(cell_text.data);
    free(cells);
    memset(out_row, 0, sizeof(*out_row));
    return result;
}

static int read_dims(GhosttyTerminal handle, uint16_t* out_cols, uint16_t* out_rows) {
    int result = ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_COLS, out_cols);
    if (result != GHOSTTY_SUCCESS) return result;
    return ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_ROWS, out_rows);
}

void adhdev_ghostty_viewport_free(AdhdevGhosttyViewport* viewport) {
    if (!viewport) return;
    if (viewport->lines) {
        for (size_t i = 0; i < viewport->line_count; i++) {
            adhdev_ghostty_row_data_release(&viewport->lines[i]);
        }
        free(viewport->lines);
    }
    free(viewport);
}

int adhdev_ghostty_terminal_get_viewport(
    AdhdevGhosttyTerminal* terminal,
    int include_rows,
    int include_cells,
    AdhdevGhosttyViewport** out_viewport) {
    if (!terminal || !terminal->handle || !out_viewport) return GHOSTTY_INVALID_VALUE;
    if (include_rows < ADHDEV_GHOSTTY_ROWS_NONE || include_rows > ADHDEV_GHOSTTY_ROWS_ALL) return GHOSTTY_INVALID_VALUE;
    *out_viewport = NULL;

    AdhdevGhosttyViewport* viewport = (AdhdevGhosttyViewport*)calloc(1, sizeof(AdhdevGhosttyViewport));
    if (!viewport) return GHOSTTY_OUT_OF_MEMORY;
    viewport->revision = terminal->revision;

    GhosttyTerminal handle = terminal->handle;
    int result = read_dims(handle, &viewport->cols, &viewport->rows);
    if (result != GHOSTTY_SUCCESS) goto fail;
    result = ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_CURSOR_X, &viewport->cursor_col);
    if (result != GHOSTTY_SUCCESS) goto fail;
    result = ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_CURSOR_Y, &viewport->cursor_row);
    if (result != GHOSTTY_SUCCESS) goto fail;
    bool pending_wrap = false;
    bool cursor_visible = false;
    result = ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_CURSOR_PENDING_WRAP, &pending_wrap);
    if (result != GHOSTTY_SUCCESS) goto fail;
    result = ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_CURSOR_VISIBLE, &cursor_visible);
    if (result != GHOSTTY_SUCCESS) goto fail;
    viewport->cursor_pending_wrap = pending_wrap;
    viewport->cursor_visible = cursor_visible;
    GhosttyTerminalScreen active_screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
    result = ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &active_screen);
    if (result != GHOSTTY_SUCCESS) goto fail;
    viewport->active_screen = active_screen == GHOSTTY_TERMINAL_SCREEN_ALTERNATE ? 1 : 0;
    GhosttyTerminalScrollbar scrollbar;
    memset(&scrollbar, 0, sizeof(scrollbar));
    result = ghostty_terminal_get(handle, GHOSTTY_TERMINAL_DATA_SCROLLBAR, &scrollbar);
    if (result != GHOSTTY_SUCCESS) goto fail;
    viewport->scrollbar_total = scrollbar.total;
    viewport->scrollbar_offset = scrollbar.offset;
    viewport->scrollbar_len = scrollbar.len;

    if (include_rows == ADHDEV_GHOSTTY_ROWS_NONE) {
        *out_viewport = viewport;
        return GHOSTTY_SUCCESS;
    }

    const uint16_t first = include_rows == ADHDEV_GHOSTTY_ROWS_ALL ? 0 : viewport->cursor_row;
    const size_t count = include_rows == ADHDEV_GHOSTTY_ROWS_ALL ? viewport->rows : 1;
    viewport->lines = (AdhdevGhosttyRowData*)calloc(count, sizeof(AdhdevGhosttyRowData));
    if (!viewport->lines) {
        result = GHOSTTY_OUT_OF_MEMORY;
        goto fail;
    }
    for (size_t i = 0; i < count; i++) {
        result = read_row_internal(
            handle,
            GHOSTTY_POINT_TAG_ACTIVE,
            (uint16_t)(first + i),
            viewport->cols,
            include_cells,
            &viewport->lines[i]);
        if (result != GHOSTTY_SUCCESS) goto fail;
        viewport->line_count = i + 1;
    }

    *out_viewport = viewport;
    return GHOSTTY_SUCCESS;

fail:
    adhdev_ghostty_viewport_free(viewport);
    return result;
}

int adhdev_ghostty_terminal_read_row(
    AdhdevGhosttyTerminal* terminal,
    int space,
    uint16_t row,
    int include_cells,
    AdhdevGhosttyRowData* out_row,
    uint64_t* out_revision) {
    if (!terminal || !terminal->handle || !out_row || !out_revision) return GHOSTTY_INVALID_VALUE;
    GhosttyPointTag tag;
    if (space == ADHDEV_GHOSTTY_SPACE_ACTIVE) {
        tag = GHOSTTY_POINT_TAG_ACTIVE;
    } else if (space == ADHDEV_GHOSTTY_SPACE_VIEWPORT) {
        tag = GHOSTTY_POINT_TAG_VIEWPORT;
    } else {
        return GHOSTTY_INVALID_VALUE;
    }

    uint16_t cols = 0;
    uint16_t rows = 0;
    int result = read_dims(terminal->handle, &cols, &rows);
    if (result != GHOSTTY_SUCCESS) return result;
    if (row >= rows) return ADHDEV_GHOSTTY_ROW_OUT_OF_RANGE;

    result = read_row_internal(terminal->handle, tag, row, cols, include_cells, out_row);
    if (result != GHOSTTY_SUCCESS) return result;
    *out_revision = terminal->revision;
    return GHOSTTY_SUCCESS;
}

int adhdev_ghostty_terminal_scroll_viewport(
    AdhdevGhosttyTerminal* terminal,
    int behavior,
    int64_t delta) {
    if (!terminal || !terminal->handle) return GHOSTTY_INVALID_VALUE;
    GhosttyTerminalScrollViewport scroll;
    memset(&scroll, 0, sizeof(scroll));
    switch (behavior) {
        case ADHDEV_GHOSTTY_SCROLL_TOP:
            scroll.tag = GHOSTTY_SCROLL_VIEWPORT_TOP;
            break;
        case ADHDEV_GHOSTTY_SCROLL_BOTTOM:
            scroll.tag = GHOSTTY_SCROLL_VIEWPORT_BOTTOM;
            break;
        case ADHDEV_GHOSTTY_SCROLL_DELTA:
            scroll.tag = GHOSTTY_SCROLL_VIEWPORT_DELTA;
            scroll.value.delta = (intptr_t)delta;
            break;
        default:
            return GHOSTTY_INVALID_VALUE;
    }
    terminal->revision++;
    ghostty_terminal_scroll_viewport(terminal->handle, scroll);
    return GHOSTTY_SUCCESS;
}

uint64_t adhdev_ghostty_terminal_revision(AdhdevGhosttyTerminal* terminal) {
    return terminal ? terminal->revision : 0;
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
        case ADHDEV_GHOSTTY_ROW_OUT_OF_RANGE:
            return "row out of range";
        default:
            return "unknown error";
    }
}
