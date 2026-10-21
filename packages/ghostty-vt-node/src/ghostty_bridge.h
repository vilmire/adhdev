#ifndef ADHDEV_GHOSTTY_BRIDGE_H
#define ADHDEV_GHOSTTY_BRIDGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct AdhdevGhosttyTerminal AdhdevGhosttyTerminal;

#define ADHDEV_GHOSTTY_SUCCESS 0
#define ADHDEV_GHOSTTY_OUT_OF_MEMORY -1
#define ADHDEV_GHOSTTY_INVALID_VALUE -2
// Bridge-level results (not produced by libghostty itself).
#define ADHDEV_GHOSTTY_ROW_OUT_OF_RANGE -100

// Version of the JS-visible binding surface. 1 = write/resize/formatPlainText/
// formatVT/getCursorPosition/dispose. 2 = adds getViewport/readRow/
// scrollViewport and the module-level getBindingInfo.
#define ADHDEV_GHOSTTY_API_LEVEL 2

// Coordinate space of a row index. ACTIVE is the rows x cols area the cursor
// moves in (what CURSOR_Y is relative to). VIEWPORT is the visible area, which
// differs from ACTIVE only while the viewport is scrolled into history.
#define ADHDEV_GHOSTTY_SPACE_ACTIVE 0
#define ADHDEV_GHOSTTY_SPACE_VIEWPORT 1

#define ADHDEV_GHOSTTY_ROWS_NONE 0
#define ADHDEV_GHOSTTY_ROWS_CURSOR 1
#define ADHDEV_GHOSTTY_ROWS_ALL 2

#define ADHDEV_GHOSTTY_SCROLL_TOP 0
#define ADHDEV_GHOSTTY_SCROLL_BOTTOM 1
#define ADHDEV_GHOSTTY_SCROLL_DELTA 2

// Matches GhosttyCellWide.
#define ADHDEV_GHOSTTY_WIDE_NARROW 0
#define ADHDEV_GHOSTTY_WIDE_WIDE 1
#define ADHDEV_GHOSTTY_WIDE_SPACER_TAIL 2
#define ADHDEV_GHOSTTY_WIDE_SPACER_HEAD 3

typedef struct {
    uint8_t wide;          // ADHDEV_GHOSTTY_WIDE_*
    uint32_t text_offset;  // byte offset into AdhdevGhosttyRowData.cell_text
    uint32_t text_len;     // UTF-8 bytes; 0 for empty cells and spacers
} AdhdevGhosttyCellInfo;

// One physical row, deep-copied out of the terminal. Owns its buffers; release
// with adhdev_ghostty_row_data_release().
typedef struct {
    uint16_t row;
    bool wrapped;            // soft-wraps into the next physical row
    bool wrap_continuation;  // continues a soft-wrap from the previous row
    char* text;              // UTF-8, trailing content-less cells omitted
    size_t text_len;
    AdhdevGhosttyCellInfo* cells;  // exactly cols entries, or NULL
    size_t cell_count;
    char* cell_text;               // concatenated per-cell UTF-8
    size_t cell_text_len;
} AdhdevGhosttyRowData;

typedef struct {
    uint64_t revision;
    uint16_t cols;
    uint16_t rows;
    uint16_t cursor_col;
    uint16_t cursor_row;  // ACTIVE space
    bool cursor_pending_wrap;
    bool cursor_visible;
    uint8_t active_screen;  // 0 = primary, 1 = alternate
    uint64_t scrollbar_total;
    uint64_t scrollbar_offset;
    uint64_t scrollbar_len;
    AdhdevGhosttyRowData* lines;  // ACTIVE rows, or NULL
    size_t line_count;
} AdhdevGhosttyViewport;

int adhdev_ghostty_terminal_create(
    uint16_t cols,
    uint16_t rows,
    size_t scrollback,
    AdhdevGhosttyTerminal** out_terminal);

int adhdev_ghostty_terminal_write(
    AdhdevGhosttyTerminal* terminal,
    const uint8_t* data,
    size_t len);

int adhdev_ghostty_terminal_resize(
    AdhdevGhosttyTerminal* terminal,
    uint16_t cols,
    uint16_t rows);

int adhdev_ghostty_terminal_format_plain_text(
    AdhdevGhosttyTerminal* terminal,
    int trim,
    char** out_text,
    size_t* out_len);

int adhdev_ghostty_terminal_format_vt(
    AdhdevGhosttyTerminal* terminal,
    char** out_text,
    size_t* out_len);

int adhdev_ghostty_terminal_cursor_position(
    AdhdevGhosttyTerminal* terminal,
    uint16_t* out_col,
    uint16_t* out_row);

// Reads metadata and (optionally) rows in one native call so they describe the
// same terminal state. include_rows is ADHDEV_GHOSTTY_ROWS_*. On success the
// caller owns *out_viewport and frees it with adhdev_ghostty_viewport_free().
int adhdev_ghostty_terminal_get_viewport(
    AdhdevGhosttyTerminal* terminal,
    int include_rows,
    int include_cells,
    AdhdevGhosttyViewport** out_viewport);

void adhdev_ghostty_viewport_free(AdhdevGhosttyViewport* viewport);

// Reads one row in the given ADHDEV_GHOSTTY_SPACE_*. Returns
// ADHDEV_GHOSTTY_ROW_OUT_OF_RANGE when row >= the native row count. On success
// *out_row owns buffers to release with adhdev_ghostty_row_data_release().
int adhdev_ghostty_terminal_read_row(
    AdhdevGhosttyTerminal* terminal,
    int space,
    uint16_t row,
    int include_cells,
    AdhdevGhosttyRowData* out_row,
    uint64_t* out_revision);

void adhdev_ghostty_row_data_release(AdhdevGhosttyRowData* row);

int adhdev_ghostty_terminal_scroll_viewport(
    AdhdevGhosttyTerminal* terminal,
    int behavior,
    int64_t delta);

uint64_t adhdev_ghostty_terminal_revision(AdhdevGhosttyTerminal* terminal);

void adhdev_ghostty_terminal_free_text(char* text, size_t len);
void adhdev_ghostty_terminal_destroy(AdhdevGhosttyTerminal* terminal);
const char* adhdev_ghostty_result_message(int result);

#ifdef __cplusplus
}
#endif

#endif
