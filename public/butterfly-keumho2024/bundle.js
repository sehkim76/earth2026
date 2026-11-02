(() => {
  "use strict";
  var e = {
      472(e, t, n) {
        n.d(t, { A: () => c });
        var o = n(645),
          r = n.n(o),
          a = n(278),
          i = n.n(a)()(r());
        i.push([
          e.id,
          ".button-container {\n  z-index: 10;\n  position: fixed;\n  top: 10px;\n  left: 10px;\n  width: 32px;\n  height: 32px;\n}\n\n.score-container {\n  z-index: 10;\n  position: fixed;\n  color: white;\n  -webkit-text-stroke: 1px black;\n  top: 10px;\n  right: 80px;\n}\n\n.timer-container {\n  z-index: 10;\n  position: fixed;\n  color: white;\n  -webkit-text-stroke: 1px black;\n  top: 10px;\n  right: 200px;\n}\n.game-finish-container {\n  display: none;\n  position: absolute;\n  padding: 0.5rem;\n  background-color: rgb(115, 110, 200);\n  border-width: 0px;\n  border-color: transparent;\n  border-radius: 10px;\n  --tw-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);\n  --tw-shadow-colored: 0 20px 25px -5px var(--tw-shadow-color),\n    0 8px 10px -6px var(--tw-shadow-color);\n  box-shadow: var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000),\n    var(--tw-shadow);\n  width: 60%;\n  height: 30%;\n  aspect-ratio: 1 / 1;\n  margin-left: 20%;\n  margin-top: 45%;\n  justify-content: center;\n  align-items: center;\n  border: 2px solid #888;\n\n  color: white;\n  z-index: 1;\n}\n\n.game-finish-container-inside {\n  display: flex;\n  margin-top: 2rem;\n  flex-direction: column;\n  justify-content: center;\n  align-items: center;\n  width: 100%;\n}\n\n.game-finish-container-inside-button {\n  width: 40%;\n  opacity: 0.7;\n  --tw-bg-opacity: 1;\n  background-color: rgb(255 255 255 / var(--tw-bg-opacity));\n  --tw-border-opacity: 1;\n  border-color: rgb(0 0 0 / var(--tw-border-opacity));\n  --tw-text-opacity: 1;\n  color: rgb(0 0 0 / var(--tw-text-opacity));\n  padding-top: 0.25rem /* 4px */;\n  padding-bottom: 0.25rem /* 4px */;\n  font-weight: 300;\n  border-width: 1px;\n  justify-content: center;\n  align-items: center;\n}\n\n.external-link-img {\n  width: 50px;\n  height: 50px;\n  cursor: pointer;\n}\n.exit-link-img {\n  width: 120px;\n  height: 60px;\n  cursor: pointer;\n}\n/* Style for \"Tap To Place Model\" text overlay */\n.over {\n  z-index: 10;\n  pointer-events: none;\n  position: absolute;\n  top: 0;\n  left: 0;\n  bottom: 80px;\n  right: 0;\n\n  text-align: center;\n  color: white;\n  font-family: 'Nunito', monospace;\n  text-shadow: 0px 0px 5px black;\n}\n#promptText {\n  font-size: 2em;\n  bottom: 12vh;\n  position: absolute;\n  left: 50%;\n  transform: translate(-50%, 0);\n}\n\n.pulse-once {\n  animation: pulse-once 0.2s cubic-bezier(0.785, 0.135, 0.15, 0.86) both;\n}\n@keyframes pulse-once {\n  0% {\n    transform: scale(1);\n  }\n  50% {\n    transform: scale(0.8);\n  }\n  100% {\n    transform: scale(1);\n  }\n}\n",
          "",
        ]);
        const c = i;
      },
      278(e) {
        e.exports = function (e) {
          var t = [];
          return (
            (t.toString = function () {
              return this.map(function (t) {
                var n = "",
                  o = void 0 !== t[5];
                return (
                  t[4] && (n += "@supports (".concat(t[4], ") {")),
                  t[2] && (n += "@media ".concat(t[2], " {")),
                  o &&
                    (n += "@layer".concat(
                      t[5].length > 0 ? " ".concat(t[5]) : "",
                      " {",
                    )),
                  (n += e(t)),
                  o && (n += "}"),
                  t[2] && (n += "}"),
                  t[4] && (n += "}"),
                  n
                );
              }).join("");
            }),
            (t.i = function (e, n, o, r, a) {
              "string" == typeof e && (e = [[null, e, void 0]]);
              var i = {};
              if (o)
                for (var c = 0; c < this.length; c++) {
                  var s = this[c][0];
                  null != s && (i[s] = !0);
                }
              for (var l = 0; l < e.length; l++) {
                var d = [].concat(e[l]);
                (o && i[d[0]]) ||
                  (void 0 !== a &&
                    (void 0 === d[5] ||
                      (d[1] = "@layer"
                        .concat(d[5].length > 0 ? " ".concat(d[5]) : "", " {")
                        .concat(d[1], "}")),
                    (d[5] = a)),
                  n &&
                    (d[2]
                      ? ((d[1] = "@media "
                          .concat(d[2], " {")
                          .concat(d[1], "}")),
                        (d[2] = n))
                      : (d[2] = n)),
                  r &&
                    (d[4]
                      ? ((d[1] = "@supports ("
                          .concat(d[4], ") {")
                          .concat(d[1], "}")),
                        (d[4] = r))
                      : (d[4] = "".concat(r))),
                  t.push(d));
              }
            }),
            t
          );
        };
      },
      645(e) {
        e.exports = function (e) {
          return e[1];
        };
      },
      292(e) {
        var t = [];
        function n(e) {
          for (var n = -1, o = 0; o < t.length; o++)
            if (t[o].identifier === e) {
              n = o;
              break;
            }
          return n;
        }
        function o(e, o) {
          for (var a = {}, i = [], c = 0; c < e.length; c++) {
            var s = e[c],
              l = o.base ? s[0] + o.base : s[0],
              d = a[l] || 0,
              p = "".concat(l, " ").concat(d);
            a[l] = d + 1;
            var u = n(p),
              m = {
                css: s[1],
                media: s[2],
                sourceMap: s[3],
                supports: s[4],
                layer: s[5],
              };
            if (-1 !== u) (t[u].references++, t[u].updater(m));
            else {
              var f = r(m, o);
              ((o.byIndex = c),
                t.splice(c, 0, { identifier: p, updater: f, references: 1 }));
            }
            i.push(p);
          }
          return i;
        }
        function r(e, t) {
          var n = t.domAPI(t);
          return (
            n.update(e),
            function (t) {
              if (t) {
                if (
                  t.css === e.css &&
                  t.media === e.media &&
                  t.sourceMap === e.sourceMap &&
                  t.supports === e.supports &&
                  t.layer === e.layer
                )
                  return;
                n.update((e = t));
              } else n.remove();
            }
          );
        }
        e.exports = function (e, r) {
          var a = o((e = e || []), (r = r || {}));
          return function (e) {
            e = e || [];
            for (var i = 0; i < a.length; i++) {
              var c = n(a[i]);
              t[c].references--;
            }
            for (var s = o(e, r), l = 0; l < a.length; l++) {
              var d = n(a[l]);
              0 === t[d].references && (t[d].updater(), t.splice(d, 1));
            }
            a = s;
          };
        };
      },
      383(e) {
        var t = {};
        e.exports = function (e, n) {
          var o = (function (e) {
            if (void 0 === t[e]) {
              var n = document.querySelector(e);
              if (
                window.HTMLIFrameElement &&
                n instanceof window.HTMLIFrameElement
              )
                try {
                  n = n.contentDocument.head;
                } catch (e) {
                  n = null;
                }
              t[e] = n;
            }
            return t[e];
          })(e);
          if (!o)
            throw new Error(
              "Couldn't find a style target. This probably means that the value for the 'insert' parameter is invalid.",
            );
          o.appendChild(n);
        };
      },
      88(e) {
        e.exports = function (e) {
          var t = document.createElement("style");
          return (e.setAttributes(t, e.attributes), e.insert(t, e.options), t);
        };
      },
      884(e, t, n) {
        e.exports = function (e) {
          var t = n.nc;
          t && e.setAttribute("nonce", t);
        };
      },
      893(e) {
        e.exports = function (e) {
          if ("undefined" == typeof document)
            return { update: function () {}, remove: function () {} };
          var t = e.insertStyleElement(e);
          return {
            update: function (n) {
              !(function (e, t, n) {
                var o = "";
                (n.supports && (o += "@supports (".concat(n.supports, ") {")),
                  n.media && (o += "@media ".concat(n.media, " {")));
                var r = void 0 !== n.layer;
                (r &&
                  (o += "@layer".concat(
                    n.layer.length > 0 ? " ".concat(n.layer) : "",
                    " {",
                  )),
                  (o += n.css),
                  r && (o += "}"),
                  n.media && (o += "}"),
                  n.supports && (o += "}"));
                var a = n.sourceMap;
                (a &&
                  "undefined" != typeof btoa &&
                  (o +=
                    "\n/*# sourceMappingURL=data:application/json;base64,".concat(
                      btoa(unescape(encodeURIComponent(JSON.stringify(a)))),
                      " */",
                    )),
                  t.styleTagTransform(o, e, t.options));
              })(t, e, n);
            },
            remove: function () {
              !(function (e) {
                if (null === e.parentNode) return !1;
                e.parentNode.removeChild(e);
              })(t);
            },
          };
        };
      },
      997(e) {
        e.exports = function (e, t) {
          if (t.styleSheet) t.styleSheet.cssText = e;
          else {
            for (; t.firstChild; ) t.removeChild(t.firstChild);
            t.appendChild(document.createTextNode(e));
          }
        };
      },
    },
    t = {};
  function n(o) {
    var r = t[o];
    if (void 0 !== r) return r.exports;
    var a = (t[o] = { id: o, exports: {} });
    return (e[o](a, a.exports, n), a.exports);
  }
  ((n.n = (e) => {
    var t = e && e.__esModule ? () => e.default : () => e;
    return (n.d(t, { a: t }), t);
  }),
    (n.d = (e, t) => {
      for (var o in t)
        n.o(t, o) &&
          !n.o(e, o) &&
          Object.defineProperty(e, o, { enumerable: !0, get: t[o] });
    }),
    (n.o = (e, t) => Object.prototype.hasOwnProperty.call(e, t)),
    (n.nc = void 0));
  var o = n(292),
    r = n.n(o),
    a = n(893),
    i = n.n(a),
    c = n(383),
    s = n.n(c),
    l = n(884),
    d = n.n(l),
    p = n(88),
    u = n.n(p),
    m = n(997),
    f = n.n(m),
    h = n(472),
    v = {};
  ((v.styleTagTransform = f()),
    (v.setAttributes = d()),
    (v.insert = s().bind(null, "head")),
    (v.domAPI = i()),
    (v.insertStyleElement = u()),
    r()(h.A, v),
    h.A && h.A.locals && h.A.locals);
  var x = 60,
    b = setInterval(function () {
      x > 0
        ? x--
        : (console.log("타이머 종료! 최종 점수: ".concat(1)), clearInterval(b));
    }, 1e3),
    g = null,
    y = null,
    w = new URLSearchParams(window.location.search),
    A = "web" === w.get("host"),
    M = w.get("exitUrl") || "/",
    P = w.get("eventkey") || w.get("eventKey") || "",
    U = w.get("userid") || "",
    L = "",
    D = "",
    N = null,
    R = !1,
    F = !1,
    S = function (e, t) {
      var n = t || {},
        o = !0 === n.waitForResponse,
        r = n.source || "unknown";
      if (!P)
        return (
          console.log("[updatescore-client] skip: eventkey missing", { source: r }),
          Promise.resolve()
        );
      if (N)
        return (
          console.log("[updatescore-client] reuse in-flight request", { source: r }),
          N
        );
      var a = JSON.stringify({
        score: Math.max(1, e | 0),
        eventkey: P,
        userId: U,
        nickname: L,
        deviceId: D,
        source: r,
      });
      return (
        console.log("[updatescore-client] start", {
          source: r,
          score: e,
          waitForResponse: o,
        }),
        (N = o
          ? fetch("/api/updatescore", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              body: a,
            })
              .then(function (e) {
                console.log("[updatescore-client] response", {
                  source: r,
                  status: e.status,
                });
                if (e.ok) R = !0;
              })
              .catch(function (e) {
                console.log("[updatescore-client] error", { source: r, error: e });
              })
          : (function () {
              if (navigator.sendBeacon)
                try {
                  var t = new Blob([a], { type: "application/json" });
                  if (navigator.sendBeacon("/api/updatescore", t))
                    return (
                      console.log("[updatescore-client] beacon queued", {
                        source: r,
                      }),
                      (R = !0),
                      Promise.resolve()
                    );
                } catch (e) {}
              return fetch("/api/updatescore", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                keepalive: !0,
                body: a,
              })
                .then(function (e) {
                  console.log("[updatescore-client] keepalive response", {
                    source: r,
                    status: e.status,
                  });
                  if (e.ok) R = !0;
                })
                .catch(function (e) {
                  console.log("[updatescore-client] keepalive error", {
                    source: r,
                    error: e,
                  });
                });
            })()),
        N.finally(function () {
          N = null;
        }),
        N
      );
    },
    k = function (e) {
      return A
        ? "".concat(M, M.includes("?") ? "&" : "?", "scoreUpdated=true&addedScore=").concat(Math.max(1, e | 0))
        : "".concat("uniwebview://close?xrartweb=butter2am", "&score=").concat(Math.max(1, e | 0));
    },
    E = function (e) {
      var t = k(e),
        n = function (o, n) {
          if (o)
            if (
              ((o.href = n),
              A
                ? ((o.target = "_top"),
                  (o.onclick = function (t) {
                    return (
                      t.preventDefault(),
                      S(e, {
                        waitForResponse: !0,
                        source: "exit-click",
                      }).finally(function () {
                        try {
                          window.top.location.href = n;
                        } catch (e) {
                          window.location.href = n;
                        }
                      }),
                      !1
                    );
                  }))
                : (o.removeAttribute("target"),
                  (o.onclick = function () {
                    S(e, { source: "native-exit-click" });
                  })),
              A)
            )
              try {
                o.setAttribute("rel", "noopener noreferrer");
              } catch (e) {}
            else o.removeAttribute("rel");
        };
      n(document.getElementById("score_link"), t);
      n(document.getElementById("back_link"), t);
    };
  window.addEventListener(
    "mediarecorder-photocomplete",
    function (e) {
      (console.log("captured", e.detail.videoBlob),
        (I = 10),
        clearInterval(b),
        setInterval(function () {
          ((g.style.display = "block"),
            (y.innerText = "총 ".concat(Math.max(1, I), "점을 획득했습니다.")),
            E(I));
        }));
    },
    1e4,
  );
  var I = 0,
    T = {
      schema: { min: { default: 8 }, max: { default: 16 } },
      init: function () {
        var e = this;
        ((g = document.getElementById("gameover_panel")),
          (y = document.getElementById("gameover_text")),
          (this.scoreValue = document.getElementById("score_value")),
          (this.timerValue = document.getElementById("timer_value")));
        var t = document.getElementById("ground");
        ((this.prompt = document.getElementById("promptText")),
          E(I),
          t.addEventListener("click", function (t) {
            e.prompt.style.display = "none";
            var n = document.createElement("a-entity"),
              o = t.detail.intersection.point;
            n.setAttribute("position", o);
            var r = 360 * Math.random();
            n.setAttribute("rotation", "0 ".concat(r, " 0"));
            var a = Math.floor(
              Math.random() * (Math.floor(e.data.max) - Math.ceil(e.data.min)) +
                Math.ceil(e.data.min),
            );
            (n.setAttribute("visible", "false"),
              n.setAttribute("scale", "0.0001 0.0001 0.0001"),
              n.setAttribute("shadow", { receive: !1 }));
            var i = Math.random();
            (i <= 0.25
              ? (n.setAttribute("gltf-model", "#awayModel"),
                n.setAttribute("modelname", "awayModel"))
              : i > 0.25 && i <= 0.5
                ? (n.setAttribute("gltf-model", "#tigerModel"),
                  n.setAttribute("modelname", "tigerModel"),
                  (a *= 4))
                : i > 0.5 && i <= 0.75
                  ? (n.setAttribute("gltf-model", "#yellowAway"),
                    n.setAttribute("modelname", "yellowAway"))
                  : i > 0.75 &&
                    i <= 1 &&
                    (n.setAttribute("gltf-model", "#purpleAway"),
                    n.setAttribute("modelname", "purpleAway")),
              n.setAttribute("character-move", { receive: !1 }),
              e.el.sceneEl.appendChild(n),
              n.addEventListener("model-loaded", function () {
                (n.setAttribute("visible", "true"),
                  n.setAttribute("animation", {
                    property: "scale",
                    to: "".concat(a, " ").concat(a, " ").concat(a),
                    easing: "easeOutElastic",
                    dur: 800,
                  }));
              }));
          }));
      },
      tick: function () {
        "block" !== g.style.display &&
          (I < 0 && (I = 0),
          (this.scoreValue.innerText = "점수 : ".concat(I)),
          (this.timerValue.innerText = "시간: ".concat(x)),
          0 === x &&
            ((g.style.display = "block"),
            (y.innerText = "총 ".concat(Math.max(1, I), "점을 획득했습니다.")),
            E(I),
            F || ((F = !0), S(I, { source: "timer-end" }))));
      },
    };
  try {
    L = (window.localStorage.getItem("ARMISSION_NICKNAME") || "").trim();
    D = (window.localStorage.getItem("ARMISSION_DEVICE_ID") || "").trim();
  } catch (e) {}
  console.log("[updatescore-client] identity snapshot", {
    userId: U,
    nickname: L,
    hasDeviceId: !!D,
  });
  window.addEventListener("pagehide", function () {
    R || S(I, { source: "pagehide" });
  });
  (AFRAME.registerComponent("tap-place", T),
    AFRAME.registerComponent("character-move", {
      tick: function (e, t) {
        var n = this.el.getAttribute("modelname");
        "tigerModel" === n
          ? this.el.setAttribute("animation-mixer", {
              clip: "Animation",
              loop: "repeat",
              crossFadeDuration: 0.4,
            })
          : "blueModel" === n
            ? this.el.setAttribute("animation-mixer", {
                clip: "Flying",
                loop: "repeat",
                crossFadeDuration: 0.4,
              })
            : this.el.setAttribute("animation-mixer", {
                clip: "Take 001",
                loop: "repeat",
                crossFadeDuration: 0.4,
              });
      },
    }));
  var C = function () {
    XR8.CanvasScreenshot.configure({ maxDimension: 1920, jpgCompression: 100 });
  };
  window.XR8 ? C() : window.addEventListener("xrloaded", C);
})();
