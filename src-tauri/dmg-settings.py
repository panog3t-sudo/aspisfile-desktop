# dmgbuild settings — generates a Finder-laid-out .dmg with proper window
# size, background, and icon positions. CI substitutes the actual .app
# path via `dmgbuild -D app=<path>`; if unset, falls back to the path Tauri
# produces for the universal macOS build.

import os.path

# `defines` is provided by dmgbuild when called with -D key=value
application = defines.get(  # type: ignore[name-defined]  # noqa: F821
    'app',
    'src-tauri/target/universal-apple-darwin/release/bundle/macos/AspisFile Viewer.app',
)
appname = os.path.basename(application)

# Volume metadata
format = 'UDZO'        # Read-only, zlib-compressed (Apple's default)
size = None            # Auto-size
filesystem = 'HFS+'

# Window
window_rect = ((100, 100), (660, 400))
default_view = 'icon-view'
show_icon_preview = False
include_icon_view_settings = True

# Background image — relative to the cwd of the dmgbuild invocation
background = 'src-tauri/icons/dmg-background.png'

# Files to ship inside the .dmg.
#
# When CI passes `-D apps_alias=<path>`, that path points at a proper
# Finder alias to /Applications generated via osascript at build time.
# Including it as a file (rather than a Unix symlink) makes Finder
# render the real Applications folder icon and animate the drag-drop
# when the user moves the app into it.
#
# Fallback: if no apps_alias was provided (e.g. osascript failed on the
# runner), we use a regular Unix symlink — same as before. UX degrades
# to "dashed empty placeholder" but the drag still works functionally.
apps_alias = defines.get('apps_alias', '')  # type: ignore[name-defined]  # noqa: F821

if apps_alias and os.path.exists(apps_alias):
    files = [application, apps_alias]
    symlinks = {}
else:
    files = [application]
    symlinks = {'Applications': '/Applications'}

# Icon layout — coordinates match the arrow in icons/dmg-background.png
icon_size = 80
text_size = 12

icon_locations = {
    appname:        (180, 200),
    'Applications': (480, 200),
}
