# Privacy Policy

**3D Scene Exporter for three.js** does not collect, store, transmit or sell any personal or usage data.

- All scanning and exporting happens locally, inside the web page you are viewing and in the extension popup.
- The extension makes **no network requests** and contains no analytics, telemetry or remote code.
- Exported files are created in your browser and saved through the normal Chrome download mechanism. They are never uploaded anywhere.
- The only information passed between parts of the extension is the number of scenes found on a tab, used to show the toolbar badge. It never leaves your browser.
- The extension stores nothing persistently.

## Why the permissions are needed
| Permission | Reason |
|---|---|
| `<all_urls>` (host access, content scripts) | three.js scenes can be on any website. The page script must run before the site's own scripts so it can detect scenes as they are created. |
| `scripting` | The popup reads the scene list and triggers exports inside the page. |
| `activeTab` | Lets the popup act on the tab you opened it from. |

Questions: open an issue on the project's GitHub repository.
