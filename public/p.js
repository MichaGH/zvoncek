/* Zvonček proposal tracker — universal, dependency-free.
 * Usage on a proposal page (token from the link query string):
 *     <script src="https://YOUR_ZVONCEK/p.js"></script>      // reads ?p=TOKEN
 * or explicit:
 *     <script src="https://YOUR_ZVONCEK/p.js" data-p="TOKEN"></script> -- pozor, pri každom načitani..
 * The endpoint is inferred from this script's own origin → /api/p.
 */
(function () {
    var script =
        document.currentScript ||
        (function () {
            var all = document.getElementsByTagName("script");
            return all[all.length - 1];
        })();

    function endpoint() {
        if (script && script.dataset && script.dataset.endpoint)
            return script.dataset.endpoint;
        try {
            return new URL(script.src).origin + "/api/p";
        } catch {
            return location.origin + "/api/p";
        }
    }

    function readToken() {
        if (script && script.dataset && script.dataset.p) return script.dataset.p;
        var m = location.search.match(/[?&](?:p|pt)=([^&]+)/);
        return m ? decodeURIComponent(m[1]) : null;
    }

    var token = readToken();
    if (!token) return;

    var url = endpoint();
    var active = 0;
    var lastTick = Date.now();
    var engagedSent = false;
    var ENGAGED_MS = 8000;

    function send(type, extra) {
        var payload = { p: token, e: type };
        if (extra) for (var k in extra) payload[k] = extra[k];
        var data = JSON.stringify(payload);
        try {
            if (navigator.sendBeacon) {
                navigator.sendBeacon(url, new Blob([data], { type: "text/plain" }));
                return;
            }
        } catch {}
        try {
            fetch(url, {
                method: "POST",
                body: data,
                keepalive: true,
                headers: { "Content-Type": "text/plain" },
            });
        } catch {}
    }

    // Strip the token from the visible URL (clean address bar + less Referer leak).
    try {
        if (history.replaceState && /[?&](?:p|pt)=/.test(location.search)) {
            var clean = location.href.replace(
                /([?&])(?:p|pt)=[^&]*(&|$)/,
                function (_, a, b) {
                    return b ? a : "";
                },
            );
            history.replaceState(null, "", clean);
        }
    } catch {}

    send("view");

    function tick() {
        var now = Date.now();
        if (document.visibilityState === "visible") active += now - lastTick;
        lastTick = now;
        if (!engagedSent && active >= ENGAGED_MS) {
            engagedSent = true;
            send("engaged", { d: active });
        }
    }
    var iv = setInterval(tick, 2000);

    // A real scroll is a strong human signal → count engagement immediately.
    window.addEventListener(
        "scroll",
        function () {
            tick();
            if (!engagedSent) {
                engagedSent = true;
                send("engaged", { d: active });
            }
        },
        { passive: true, once: true },
    );

    function finish() {
        tick();
        clearInterval(iv);
        // Capture short reads too: send the accumulated time once, if not already engaged.
        if (!engagedSent && active > 0) {
            engagedSent = true;
            send("engaged", { d: active });
        }
    }
    window.addEventListener("pagehide", finish);
    document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") finish();
    });
})();
