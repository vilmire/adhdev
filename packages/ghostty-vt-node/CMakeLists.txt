cmake_minimum_required(VERSION 3.20)
project(ghostty_vt_node LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

include(FetchContent)

execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR "${NODE_ADDON_API_DIR}")

set(GHOSTTY_GIT_TAG "d4a38c8661453026bd1b1bb022ba2c37b347adce" CACHE STRING "Ghostty git revision for libghostty-vt")
# The pin itself, independent of the overridable cache entry above.
set(ADHDEV_GHOSTTY_PINNED_REVISION "d4a38c8661453026bd1b1bb022ba2c37b347adce")

if(DEFINED ENV{ZIG_EXECUTABLE} AND NOT DEFINED ZIG_EXECUTABLE)
  set(ZIG_EXECUTABLE "$ENV{ZIG_EXECUTABLE}" CACHE FILEPATH "Path to zig executable")
endif()

# --- Build provenance ---------------------------------------------------------
# A release binary must be built from exactly the pinned ghostty revision, in a
# clean FetchContent-managed clone, with the pinned zig, and its libghostty-vt
# must be built by THIS build from fresh, private zig caches (see "Runtime
# freshness" below). Each violation
# is a problem code; any problem fails the configure step unless the explicit
# developer override ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD=1 (cache variable or
# environment) is set. The override ALWAYS makes the build non-release, even
# with nothing else wrong: the binary reports releaseEligible=false and the
# prebuilt release gates refuse it. Only problem codes are embedded, never paths.
#
# toolchain.json is the single zig pin: the native workflow installs that
# version and the release gate compares against it. It is a binding digest
# input, so changing the pin invalidates every existing prebuilt.
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/toolchain.json" ADHDEV_TOOLCHAIN_JSON)
string(JSON ADHDEV_PINNED_ZIG_VERSION GET "${ADHDEV_TOOLCHAIN_JSON}" zig)

set(ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD OFF CACHE BOOL "Allow a non-release build from an unverified ghostty source or toolchain")
if("$ENV{ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD}" STREQUAL "1")
  set(ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD ON)
endif()
set(ADHDEV_PROVENANCE_PROBLEMS "")
if(ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD)
  list(APPEND ADHDEV_PROVENANCE_PROBLEMS "unverified-dev-build")
endif()
if(NOT GHOSTTY_GIT_TAG STREQUAL ADHDEV_GHOSTTY_PINNED_REVISION)
  list(APPEND ADHDEV_PROVENANCE_PROBLEMS "ghostty-tag-override")
endif()
# A substituted checkout is not under this build's control (it may be shared,
# reused or written to while building). Release builds use the managed clone.
if(FETCHCONTENT_SOURCE_DIR_GHOSTTY)
  list(APPEND ADHDEV_PROVENANCE_PROBLEMS "ghostty-source-override")
endif()

# User-supplied extra zig flags change the library ghostty builds.
if(NOT "${GHOSTTY_ZIG_BUILD_FLAGS}" STREQUAL "")
  list(APPEND ADHDEV_PROVENANCE_PROBLEMS "extra-zig-build-flags")
endif()

# Resolve zig and record the version that actually builds libghostty-vt. The whole output, with
# only surrounding whitespace/CRLF trimmed, must equal the pin exactly.
find_program(ZIG_EXECUTABLE zig REQUIRED)
execute_process(
  COMMAND "${ZIG_EXECUTABLE}" version
  OUTPUT_VARIABLE zig_version_output
  RESULT_VARIABLE zig_version_result
  ERROR_QUIET
)
string(STRIP "${zig_version_output}" zig_version_output)
if(zig_version_result EQUAL 0 AND zig_version_output STREQUAL ADHDEV_PINNED_ZIG_VERSION)
  set(ADHDEV_ZIG_VERSION "${ADHDEV_PINNED_ZIG_VERSION}")
else()
  list(APPEND ADHDEV_PROVENANCE_PROBLEMS "zig-version-mismatch")
  # Recorded for diagnostics only, and only if it is a plain version token.
  if(zig_version_output MATCHES "^[0-9A-Za-z.+-]+$")
    set(ADHDEV_ZIG_VERSION "${zig_version_output}")
  else()
    set(ADHDEV_ZIG_VERSION "unrecognized")
  endif()
endif()

# Only the SOURCE is taken from the clone. Upstream's CMakeLists.txt is not
# added (SOURCE_SUBDIR points at a directory without one): it builds through an
# OUTPUT-only custom command with the ambient zig caches and installs into the
# git-ignored zig-out/ of the source tree, none of which this build can vouch
# for. libghostty-vt is built by adhdev_ghostty_runtime below instead.
FetchContent_Declare(ghostty
  GIT_REPOSITORY https://github.com/ghostty-org/ghostty.git
  GIT_TAG ${GHOSTTY_GIT_TAG}
  SOURCE_SUBDIR adhdev-no-upstream-cmake
)
FetchContent_MakeAvailable(ghostty)

# The DECLARED tag proves nothing: FETCHCONTENT_SOURCE_DIR_GHOSTTY can point at
# any checkout. Verify the source that is actually built.
find_package(Git QUIET)
find_program(ADHDEV_NODE_EXECUTABLE node REQUIRED)
set(ADHDEV_GHOSTTY_SOURCE_REVISION "")
set(ADHDEV_GHOSTTY_SOURCE_CLEAN 0)
if(GIT_EXECUTABLE)
  execute_process(
    COMMAND "${GIT_EXECUTABLE}" -C "${ghostty_SOURCE_DIR}" rev-parse HEAD
    OUTPUT_VARIABLE ghostty_head
    OUTPUT_STRIP_TRAILING_WHITESPACE
    RESULT_VARIABLE ghostty_head_result
    ERROR_QUIET
  )
  execute_process(
    COMMAND "${GIT_EXECUTABLE}" -C "${ghostty_SOURCE_DIR}" status --porcelain
    OUTPUT_VARIABLE ghostty_status
    OUTPUT_STRIP_TRAILING_WHITESPACE
    RESULT_VARIABLE ghostty_status_result
    ERROR_QUIET
  )
  if(ghostty_head_result EQUAL 0 AND ghostty_head MATCHES "^[0-9a-f]+$")
    set(ADHDEV_GHOSTTY_SOURCE_REVISION "${ghostty_head}")
  endif()
  if(ghostty_status_result EQUAL 0 AND ghostty_status STREQUAL "")
    set(ADHDEV_GHOSTTY_SOURCE_CLEAN 1)
  endif()
endif()
if(ADHDEV_GHOSTTY_SOURCE_REVISION STREQUAL "")
  list(APPEND ADHDEV_PROVENANCE_PROBLEMS "ghostty-source-not-a-git-checkout")
elseif(NOT ADHDEV_GHOSTTY_SOURCE_REVISION STREQUAL ADHDEV_GHOSTTY_PINNED_REVISION)
  list(APPEND ADHDEV_PROVENANCE_PROBLEMS "ghostty-head-mismatch")
endif()
if(NOT ADHDEV_GHOSTTY_SOURCE_CLEAN)
  list(APPEND ADHDEV_PROVENANCE_PROBLEMS "ghostty-source-dirty")
endif()

set(ADHDEV_VERIFY_GHOSTTY_SCRIPT "${CMAKE_CURRENT_BINARY_DIR}/adhdev-verify-ghostty-source.cmake")
file(WRITE "${ADHDEV_VERIFY_GHOSTTY_SCRIPT}" [==[
# Generated by ghostty-vt-node/CMakeLists.txt: re-verify at build time that the
# ghostty source is still the pinned revision with a clean tree.
execute_process(COMMAND "${GIT}" -C "${SRC}" rev-parse HEAD
  OUTPUT_VARIABLE head OUTPUT_STRIP_TRAILING_WHITESPACE RESULT_VARIABLE head_result ERROR_QUIET)
execute_process(COMMAND "${GIT}" -C "${SRC}" status --porcelain
  OUTPUT_VARIABLE status OUTPUT_STRIP_TRAILING_WHITESPACE RESULT_VARIABLE status_result ERROR_QUIET)
if(NOT head_result EQUAL 0 OR NOT head STREQUAL PIN)
  message(FATAL_ERROR "ghostty-vt-node: ghostty source HEAD is '${head}', not the pin ${PIN}; reconfigure")
endif()
if(NOT status_result EQUAL 0 OR NOT status STREQUAL "")
  message(FATAL_ERROR "ghostty-vt-node: ghostty source tree changed since configure; reconfigure from a clean clone")
endif()
]==])

if(ADHDEV_PROVENANCE_PROBLEMS)
  if(NOT ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD)
    message(FATAL_ERROR
      "ghostty-vt-node build provenance check failed: ${ADHDEV_PROVENANCE_PROBLEMS}\n"
      "  ghostty pin ${ADHDEV_GHOSTTY_PINNED_REVISION}, resolved '${ADHDEV_GHOSTTY_SOURCE_REVISION}' (clean=${ADHDEV_GHOSTTY_SOURCE_CLEAN})\n"
      "  zig pin ${ADHDEV_PINNED_ZIG_VERSION} (toolchain.json), found '${ADHDEV_ZIG_VERSION}'\n"
      "Fix the toolchain/source, or set ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD=1 for a local NON-RELEASE build "
      "(the prebuilt release gates refuse it).")
  endif()
  message(WARNING "ghostty-vt-node: NON-RELEASE build (${ADHDEV_PROVENANCE_PROBLEMS})")
  set(ADHDEV_GHOSTTY_RELEASE_ELIGIBLE 0)
else()
  set(ADHDEV_GHOSTTY_RELEASE_ELIGIBLE 1)
endif()
string(REPLACE ";" "," ADHDEV_PROVENANCE_PROBLEMS_TEXT "${ADHDEV_PROVENANCE_PROBLEMS}")
message(STATUS "ghostty-vt-node provenance: ghostty ${ADHDEV_GHOSTTY_SOURCE_REVISION} clean=${ADHDEV_GHOSTTY_SOURCE_CLEAN} zig ${ADHDEV_ZIG_VERSION} release=${ADHDEV_GHOSTTY_RELEASE_ELIGIBLE}")

# --- Runtime freshness --------------------------------------------------------
# HEAD/status/zig checks describe the INPUTS; the runtime must also be built
# from them and nothing else. Everything zig reads or writes besides the
# verified source and the pinned zig lives in this build tree:
#   ghostty-zig/global-cache  zig's global cache, incl. fetched packages (p/)
#   ghostty-zig/local-cache   zig's local cache (compiled artifacts)
#   ghostty-zig/prefix        the install prefix the addon links and ships
# They are passed as --global-cache-dir / --cache-dir / --prefix, which take
# precedence over ZIG_GLOBAL_CACHE_DIR / ZIG_LOCAL_CACHE_DIR, so ambient caches
# are never read: overriding them (rather than refusing a build with them set)
# keeps CI and developer environments working while removing their influence.
# Zig accepts an existing package directory in a cache without re-hashing it,
# and reuses cache hits as-is, so for a RELEASE build all three are deleted at
# every configure: dependencies are fetched afresh (zig verifies each package
# hash on fetch) and everything is compiled from scratch. A non-release
# (ADHDEV_GHOSTTY_UNVERIFIED_DEV_BUILD) build keeps them between configures.
#
# adhdev_ghostty_runtime runs `zig build` on EVERY build, before the addon links
# and copies the runtime, so a library left in the prefix is re-installed from
# this build's cache; for a release build it re-verifies the pinned, clean
# source before and after.
#
# LIMITATION: these checks are check-then-use, not atomic. A release build
# assumes exclusive ownership of the build tree, the ghostty clone and the zig
# installation for the whole configure + build: a concurrent writer could
# change an input between a check and its use. Build release prebuilts on a
# machine and in directories no other process writes to.
set(ADHDEV_GHOSTTY_ZIG_DIR "${CMAKE_CURRENT_BINARY_DIR}/ghostty-zig")
set(ADHDEV_ZIG_GLOBAL_CACHE "${ADHDEV_GHOSTTY_ZIG_DIR}/global-cache")
set(ADHDEV_ZIG_LOCAL_CACHE "${ADHDEV_GHOSTTY_ZIG_DIR}/local-cache")
set(ADHDEV_GHOSTTY_PREFIX "${ADHDEV_GHOSTTY_ZIG_DIR}/prefix")
if(ADHDEV_GHOSTTY_RELEASE_ELIGIBLE)
  # Not file(REMOVE_RECURSE): on Windows it stops part-way on names Win32
  # normalizes away (zig extracts macOS `._.` files into the package cache),
  # silently keeping cached packages. scripts/clean-dir.cjs removes them, and a
  # clean that leaves anything behind fails the configure; a release build never
  # proceeds on a partially emptied cache.
  execute_process(
    COMMAND "${ADHDEV_NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/scripts/clean-dir.cjs" "${ADHDEV_GHOSTTY_ZIG_DIR}"
    RESULT_VARIABLE adhdev_clean_result
    OUTPUT_VARIABLE adhdev_clean_output
    ERROR_VARIABLE adhdev_clean_output
  )
  if(NOT adhdev_clean_result EQUAL 0 OR EXISTS "${ADHDEV_GHOSTTY_ZIG_DIR}")
    message(FATAL_ERROR
      "ghostty-vt-node: could not empty the private zig caches in ${ADHDEV_GHOSTTY_ZIG_DIR} "
      "(exit ${adhdev_clean_result}): ${adhdev_clean_output}\n"
      "A release build must start from empty caches. Remove the directory by hand, "
      "and make sure no other process is using it.")
  endif()
endif()
file(MAKE_DIRECTORY "${ADHDEV_ZIG_GLOBAL_CACHE}" "${ADHDEV_ZIG_LOCAL_CACHE}" "${ADHDEV_GHOSTTY_PREFIX}/include")
if(DEFINED ENV{ZIG_GLOBAL_CACHE_DIR} OR DEFINED ENV{ZIG_LOCAL_CACHE_DIR})
  message(STATUS "ghostty-vt-node: ZIG_GLOBAL_CACHE_DIR / ZIG_LOCAL_CACHE_DIR are ignored; zig uses the private caches in ${ADHDEV_GHOSTTY_ZIG_DIR}")
endif()

# Upstream's zig flags: build types with optimization map to ReleaseFast.
set(ADHDEV_GHOSTTY_ZIG_FLAGS -Demit-lib-vt ${GHOSTTY_ZIG_BUILD_FLAGS})
string(TOUPPER "${CMAKE_BUILD_TYPE}" adhdev_build_type)
if(adhdev_build_type STREQUAL "RELEASE" OR adhdev_build_type STREQUAL "MINSIZEREL" OR adhdev_build_type STREQUAL "RELWITHDEBINFO")
  list(APPEND ADHDEV_GHOSTTY_ZIG_FLAGS "-Doptimize=ReleaseFast")
endif()

# The library names upstream's CMake wrapper uses at the pinned revision.
if(APPLE)
  set(GHOSTTY_VT_SONAME "libghostty-vt.0.dylib")
  set(GHOSTTY_VT_SHARED_LIBRARY "${ADHDEV_GHOSTTY_PREFIX}/lib/libghostty-vt.0.1.0.dylib")
elseif(WIN32)
  set(GHOSTTY_VT_SHARED_LIBRARY "${ADHDEV_GHOSTTY_PREFIX}/bin/ghostty-vt.dll")
  set(GHOSTTY_VT_IMPLIB "${ADHDEV_GHOSTTY_PREFIX}/lib/ghostty-vt.lib")
else()
  set(GHOSTTY_VT_SONAME "libghostty-vt.so.0")
  set(GHOSTTY_VT_SHARED_LIBRARY "${ADHDEV_GHOSTTY_PREFIX}/lib/libghostty-vt.so.0.1.0")
endif()

if(ADHDEV_GHOSTTY_RELEASE_ELIGIBLE)
  set(ADHDEV_VERIFY_GHOSTTY_COMMAND
    "${CMAKE_COMMAND}" "-DGIT=${GIT_EXECUTABLE}" "-DSRC=${ghostty_SOURCE_DIR}"
    "-DPIN=${ADHDEV_GHOSTTY_PINNED_REVISION}" -P "${ADHDEV_VERIFY_GHOSTTY_SCRIPT}")
else()
  set(ADHDEV_VERIFY_GHOSTTY_COMMAND "${CMAKE_COMMAND}" -E echo "ghostty-vt-node: non-release build, source not re-verified")
endif()
add_custom_target(adhdev_ghostty_runtime
  COMMAND ${ADHDEV_VERIFY_GHOSTTY_COMMAND}
  COMMAND "${ZIG_EXECUTABLE}" build ${ADHDEV_GHOSTTY_ZIG_FLAGS}
    --prefix "${ADHDEV_GHOSTTY_PREFIX}"
    --cache-dir "${ADHDEV_ZIG_LOCAL_CACHE}"
    --global-cache-dir "${ADHDEV_ZIG_GLOBAL_CACHE}"
  COMMAND ${ADHDEV_VERIFY_GHOSTTY_COMMAND}
  BYPRODUCTS "${GHOSTTY_VT_SHARED_LIBRARY}" ${GHOSTTY_VT_IMPLIB}
  WORKING_DIRECTORY "${ghostty_SOURCE_DIR}"
  COMMENT "Building libghostty-vt with zig (always; private caches and prefix)"
  VERBATIM
)

add_library(ghostty-vt SHARED IMPORTED GLOBAL)
set_target_properties(ghostty-vt PROPERTIES
  IMPORTED_LOCATION "${GHOSTTY_VT_SHARED_LIBRARY}"
  INTERFACE_INCLUDE_DIRECTORIES "${ADHDEV_GHOSTTY_PREFIX}/include"
)
if(APPLE)
  set_target_properties(ghostty-vt PROPERTIES IMPORTED_SONAME "@rpath/${GHOSTTY_VT_SONAME}")
elseif(WIN32)
  set_target_properties(ghostty-vt PROPERTIES IMPORTED_IMPLIB "${GHOSTTY_VT_IMPLIB}")
else()
  set_target_properties(ghostty-vt PROPERTIES IMPORTED_SONAME "${GHOSTTY_VT_SONAME}")
endif()
add_dependencies(ghostty-vt adhdev_ghostty_runtime)

add_library(${PROJECT_NAME} SHARED
  src/addon.cc
  src/ghostty_bridge.c
)
add_dependencies(${PROJECT_NAME} adhdev_ghostty_runtime)

set(GHOSTTY_VT_RUNTIME_ALIAS "${CMAKE_SHARED_LIBRARY_PREFIX}ghostty-vt${CMAKE_SHARED_LIBRARY_SUFFIX}")

target_include_directories(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_INC}
  ${NODE_ADDON_API_DIR}
)

# Binding source digest, embedded so a compiled binary can be matched against
# the sources it was built from. scripts/binding-digest.mjs implements the same
# algorithm: per file "<path>:<sha256 of LF-normalized content>\n", in this
# order, then sha256 of the concatenation. Reconfigure whenever an input
# changes so an incremental compile never embeds a stale digest.
set(ADHDEV_BINDING_DIGEST_INPUTS
  CMakeLists.txt
  toolchain.json
  src/addon.cc
  src/ghostty_bridge.c
  src/ghostty_bridge.h
  scripts/clean-dir.cjs
)
set(ADHDEV_BINDING_DIGEST_MANIFEST "")
foreach(input IN LISTS ADHDEV_BINDING_DIGEST_INPUTS)
  file(READ "${CMAKE_CURRENT_SOURCE_DIR}/${input}" input_content)
  string(REPLACE "\r\n" "\n" input_content "${input_content}")
  string(SHA256 input_hash "${input_content}")
  string(APPEND ADHDEV_BINDING_DIGEST_MANIFEST "${input}:${input_hash}\n")
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/${input}")
endforeach()
string(SHA256 ADHDEV_BINDING_SOURCE_DIGEST "${ADHDEV_BINDING_DIGEST_MANIFEST}")
message(STATUS "ghostty-vt-node binding source digest: ${ADHDEV_BINDING_SOURCE_DIGEST}")

target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_DISABLE_CPP_EXCEPTIONS
  NAPI_VERSION=8
  GHOSTTY_STATIC
  ADHDEV_GHOSTTY_SOURCE_DIGEST="${ADHDEV_BINDING_SOURCE_DIGEST}"
  ADHDEV_GHOSTTY_GIT_TAG="${GHOSTTY_GIT_TAG}"
  ADHDEV_GHOSTTY_RELEASE_ELIGIBLE=${ADHDEV_GHOSTTY_RELEASE_ELIGIBLE}
  ADHDEV_GHOSTTY_PROVENANCE_PROBLEMS="${ADHDEV_PROVENANCE_PROBLEMS_TEXT}"
  ADHDEV_GHOSTTY_SOURCE_REVISION="${ADHDEV_GHOSTTY_SOURCE_REVISION}"
  ADHDEV_GHOSTTY_SOURCE_CLEAN=${ADHDEV_GHOSTTY_SOURCE_CLEAN}
  ADHDEV_GHOSTTY_ZIG_VERSION="${ADHDEV_ZIG_VERSION}"
  ADHDEV_GHOSTTY_C_COMPILER="${CMAKE_C_COMPILER_ID} ${CMAKE_C_COMPILER_VERSION}"
  ADHDEV_GHOSTTY_CXX_COMPILER="${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}"
  ADHDEV_GHOSTTY_BUILD_TYPE="${CMAKE_BUILD_TYPE}"
)

target_link_libraries(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_LIB}
  ghostty-vt
)

set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

if(MSVC)
  # cmake-js injects CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded (/MT) globally.
  # Node.js addons must use /MD (dynamic CRT) to match node.exe.
  # Override to MultiThreadedDLL, suppress static CRT, and explicitly link the
  # three dynamic-CRT import libs (msvcrt/vcruntime/ucrt) that the auto-link
  # mechanism may not pick up when cmake-js has overridden the global setting.
  set_target_properties(${PROJECT_NAME} PROPERTIES
    MSVC_RUNTIME_LIBRARY "MultiThreadedDLL"
  )
  target_link_options(${PROJECT_NAME} PRIVATE
    /NODEFAULTLIB:LIBCMT
    /NODEFAULTLIB:LIBCMTD
  )
  target_link_libraries(${PROJECT_NAME} PRIVATE msvcrt vcruntime ucrt)
endif()

if(APPLE)
  set_target_properties(${PROJECT_NAME} PROPERTIES
    BUILD_RPATH "@loader_path"
    INSTALL_RPATH "@loader_path"
  )
  target_link_options(${PROJECT_NAME} PRIVATE "-undefined dynamic_lookup")
elseif(UNIX)
  set_target_properties(${PROJECT_NAME} PROPERTIES
    BUILD_RPATH "$ORIGIN"
    INSTALL_RPATH "$ORIGIN"
  )
endif()

add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    $<TARGET_FILE:ghostty-vt>
    $<TARGET_FILE_DIR:${PROJECT_NAME}>/$<TARGET_FILE_NAME:ghostty-vt>
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    $<TARGET_FILE:ghostty-vt>
    $<TARGET_FILE_DIR:${PROJECT_NAME}>/${GHOSTTY_VT_RUNTIME_ALIAS}
)
