var Mn = (() => {
    var qe = import.meta.url;
    return function (Fr = {}) {
        var Ge,
            o = Fr,
            Je,
            ve,
            Mr = new Promise((e, r) => {
                (Je = e), (ve = r);
            }),
            Rr = typeof window == "object",
            Fe = typeof importScripts == "function";
        typeof process == "object" && typeof process.versions == "object" && process.versions.node;
        var Ke = !1;
        o.setup = function () {
            if (Ke) return;
            (Ke = !0), o.initTBB();
            function e(i, s, f = (d) => d) {
                if (s) for (let d of s) i.push_back(f(d));
                return i;
            }
            function r(i, s = (f) => f) {
                const f = [],
                    d = i.size();
                for (let y = 0; y < d; y++) f.push(s(i.get(y)));
                return f;
            }
            function t(i, s = (f) => f) {
                const f = [],
                    d = i.size();
                for (let y = 0; y < d; y++) {
                    const b = i.get(y),
                        w = b.size(),
                        E = [];
                    for (let S = 0; S < w; S++) E.push(s(b.get(S)));
                    f.push(E);
                }
                return f;
            }
            function n(i) {
                return i[0].length < 3 && (i = [i]), e(new o.Vector2_vec2(), i, (s) => e(new o.Vector_vec2(), s, (f) => (f instanceof Array ? { x: f[0], y: f[1] } : f)));
            }
            function a(i) {
                for (let s = 0; s < i.size(); s++) i.get(s).delete();
                i.delete();
            }
            function u(i) {
                return i[0] instanceof Array ? { x: i[0][0], y: i[0][1] } : typeof i[0] == "number" ? { x: i[0] || 0, y: i[1] || 0 } : i[0];
            }
            function l(i) {
                return i[0] instanceof Array ? { x: i[0][0], y: i[0][1], z: i[0][2] } : typeof i[0] == "number" ? { x: i[0] || 0, y: i[1] || 0, z: i[2] || 0 } : i[0];
            }
            function c(i) {
                return i == "EvenOdd" ? 0 : i == "NonZero" ? 1 : i == "Negative" ? 3 : 2;
            }
            function p(i) {
                return i == "Round" ? 1 : i == "Miter" ? 2 : 0;
            }
            const v = o.CrossSection;
            function h(i, s = "Positive") {
                if (i instanceof v) return i;
                {
                    const f = n(i),
                        d = new v(f, c(s));
                    return a(f), d;
                }
            }
            (o.CrossSection.prototype.translate = function (...i) {
                return this._Translate(u(i));
            }),
                (o.CrossSection.prototype.scale = function (i) {
                    return typeof i == "number" ? this._Scale({ x: i, y: i }) : this._Scale(u([i]));
                }),
                (o.CrossSection.prototype.mirror = function (i) {
                    return this._Mirror(u([i]));
                }),
                (o.CrossSection.prototype.warp = function (i) {
                    const s = le(function (d) {
                            const y = k(d, "double"),
                                b = k(d + 8, "double"),
                                w = [y, b];
                            i(w), K(d, w[0], "double"), K(d + 8, w[1], "double");
                        }, "vi"),
                        f = this._Warp(s);
                    return de(s), f;
                }),
                (o.CrossSection.prototype.decompose = function () {
                    const i = this._Decompose(),
                        s = r(i);
                    return i.delete(), s;
                }),
                (o.CrossSection.prototype.bounds = function () {
                    const i = this._Bounds();
                    return { min: ["x", "y"].map((s) => i.min[s]), max: ["x", "y"].map((s) => i.max[s]) };
                }),
                (o.CrossSection.prototype.offset = function (i, s = "Round", f = 2, d = 0) {
                    return this._Offset(i, p(s), f, d);
                }),
                (o.CrossSection.prototype.simplify = function (i = 1e-6) {
                    return this._Simplify(i);
                }),
                (o.CrossSection.prototype.extrude = function (i, s = 0, f = 0, d = [1, 1], y = !1) {
                    d = u([d]);
                    const b = o._Extrude(this._ToPolygons(), i, s, f, d);
                    return y ? b.translate([0, 0, -i / 2]) : b;
                }),
                (o.CrossSection.prototype.revolve = function (i = 0, s = 360) {
                    return o._Revolve(this._ToPolygons(), i, s);
                }),
                (o.CrossSection.prototype.add = function (i) {
                    return this._add(h(i));
                }),
                (o.CrossSection.prototype.subtract = function (i) {
                    return this._subtract(h(i));
                }),
                (o.CrossSection.prototype.intersect = function (i) {
                    return this._intersect(h(i));
                }),
                (o.CrossSection.prototype.toPolygons = function () {
                    const i = this._ToPolygons(),
                        s = t(i, (f) => [f.x, f.y]);
                    return i.delete(), s;
                }),
                (o.Manifold.prototype.smoothOut = function (i = 60, s = 0) {
                    return this._SmoothOut(i, s);
                }),
                (o.Manifold.prototype.warp = function (i) {
                    const s = le(function (y) {
                            const b = k(y, "double"),
                                w = k(y + 8, "double"),
                                E = k(y + 16, "double"),
                                S = [b, w, E];
                            i(S), K(y, S[0], "double"), K(y + 8, S[1], "double"), K(y + 16, S[2], "double");
                        }, "vi"),
                        f = this._Warp(s);
                    de(s);
                    const d = f.status();
                    if (d !== "NoError") throw new o.ManifoldError(d);
                    return f;
                }),
                (o.Manifold.prototype.calculateNormals = function (i, s = 60) {
                    return this._CalculateNormals(i, s);
                }),
                (o.Manifold.prototype.setProperties = function (i, s) {
                    const f = this.numProp(),
                        d = le(function (b, w, E) {
                            const S = [];
                            for (let T = 0; T < i; ++T) S[T] = k(b + 8 * T, "double");
                            const Y = [];
                            for (let T = 0; T < 3; ++T) Y[T] = k(w + 8 * T, "double");
                            const ee = [];
                            for (let T = 0; T < f; ++T) ee[T] = k(E + 8 * T, "double");
                            s(S, Y, ee);
                            for (let T = 0; T < i; ++T) K(b + 8 * T, S[T], "double");
                        }, "viii"),
                        y = this._SetProperties(i, d);
                    return de(d), y;
                }),
                (o.Manifold.prototype.translate = function (...i) {
                    return this._Translate(l(i));
                }),
                (o.Manifold.prototype.rotate = function (i, s, f) {
                    return Array.isArray(i) ? this._Rotate(...i) : this._Rotate(i, s || 0, f || 0);
                }),
                (o.Manifold.prototype.scale = function (i) {
                    return typeof i == "number" ? this._Scale({ x: i, y: i, z: i }) : this._Scale(l([i]));
                }),
                (o.Manifold.prototype.mirror = function (i) {
                    return this._Mirror(l([i]));
                }),
                (o.Manifold.prototype.trimByPlane = function (i, s = 0) {
                    return this._TrimByPlane(l([i]), s);
                }),
                (o.Manifold.prototype.slice = function (i = 0) {
                    const s = this._Slice(i),
                        f = new v(s, c("Positive"));
                    return a(s), f;
                }),
                (o.Manifold.prototype.project = function () {
                    const i = this._Project(),
                        s = new v(i, c("Positive"));
                    return a(i), s;
                }),
                (o.Manifold.prototype.split = function (i) {
                    const s = this._Split(i),
                        f = r(s);
                    return s.delete(), f;
                }),
                (o.Manifold.prototype.splitByPlane = function (i, s = 0) {
                    const f = this._SplitByPlane(l([i]), s),
                        d = r(f);
                    return f.delete(), d;
                }),
                (o.Manifold.prototype.decompose = function () {
                    const i = this._Decompose(),
                        s = r(i);
                    return i.delete(), s;
                }),
                (o.Manifold.prototype.boundingBox = function () {
                    const i = this._boundingBox();
                    return { min: ["x", "y", "z"].map((s) => i.min[s]), max: ["x", "y", "z"].map((s) => i.max[s]) };
                });
            class _ {
                constructor({
                    numProp: s = 3,
                    triVerts: f = new Uint32Array(),
                    vertProperties: d = new Float32Array(),
                    mergeFromVert: y,
                    mergeToVert: b,
                    runIndex: w,
                    runOriginalID: E,
                    faceID: S,
                    halfedgeTangent: Y,
                    runTransform: ee,
                } = {}) {
                    (this.numProp = s),
                        (this.triVerts = f),
                        (this.vertProperties = d),
                        (this.mergeFromVert = y),
                        (this.mergeToVert = b),
                        (this.runIndex = w),
                        (this.runOriginalID = E),
                        (this.faceID = S),
                        (this.halfedgeTangent = Y),
                        (this.runTransform = ee);
                }
                get numTri() {
                    return this.triVerts.length / 3;
                }
                get numVert() {
                    return this.vertProperties.length / this.numProp;
                }
                get numRun() {
                    return this.runOriginalID.length;
                }
                merge() {
                    const { changed: s, mesh: f } = o._Merge(this);
                    return Object.assign(this, { ...f }), s;
                }
                verts(s) {
                    return this.triVerts.subarray(3 * s, 3 * (s + 1));
                }
                position(s) {
                    return this.vertProperties.subarray(this.numProp * s, this.numProp * s + 3);
                }
                extras(s) {
                    return this.vertProperties.subarray(this.numProp * s + 3, this.numProp * (s + 1));
                }
                tangent(s) {
                    return this.halfedgeTangent.subarray(4 * s, 4 * (s + 1));
                }
                transform(s) {
                    const f = new Array(16);
                    for (const d of [0, 1, 2, 3]) for (const y of [0, 1, 2]) f[4 * d + y] = this.runTransform[12 * s + 3 * d + y];
                    return (f[15] = 1), f;
                }
            }
            (o.Mesh = _),
                (o.Manifold.prototype.getMesh = function (i = -1) {
                    return new _(this._GetMeshJS(i));
                }),
                (o.ManifoldError = function (s, ...f) {
                    let d = "Unknown error";
                    switch (s) {
                        case "NonFiniteVertex":
                            d = "Non-finite vertex";
                            break;
                        case "NotManifold":
                            d = "Not manifold";
                            break;
                        case "VertexOutOfBounds":
                            d = "Vertex index out of bounds";
                            break;
                        case "PropertiesWrongLength":
                            d = "Properties have wrong length";
                            break;
                        case "MissingPositionProperties":
                            d = "Less than three properties";
                            break;
                        case "MergeVectorsDifferentLengths":
                            d = "Merge vectors have different lengths";
                            break;
                        case "MergeIndexOutOfBounds":
                            d = "Merge index out of bounds";
                            break;
                        case "TransformWrongLength":
                            d = "Transform vector has wrong length";
                            break;
                        case "RunIndexWrongLength":
                            d = "Run index vector has wrong length";
                            break;
                        case "FaceIDWrongLength":
                            d = "Face ID vector has wrong length";
                        case "InvalidConstruction":
                            d = "Manifold constructed with invalid parameters";
                    }
                    const y = Error.apply(this, [d, ...f]);
                    (y.name = this.name = "ManifoldError"), (this.message = y.message), (this.stack = y.stack), (this.code = s);
                }),
                (o.ManifoldError.prototype = Object.create(Error.prototype, { constructor: { value: o.ManifoldError, writable: !0, configurable: !0 } })),
                (o.CrossSection = function (i, s = "Positive") {
                    const f = n(i),
                        d = new v(f, c(s));
                    return a(f), d;
                }),
                (o.CrossSection.ofPolygons = function (i, s = "Positive") {
                    return new o.CrossSection(i, s);
                }),
                (o.CrossSection.square = function (...i) {
                    let s;
                    i.length == 0 ? (s = { x: 1, y: 1 }) : typeof i[0] == "number" ? (s = { x: i[0], y: i[0] }) : (s = u(i));
                    const f = i[1] || !1;
                    return o._Square(s, f);
                }),
                (o.CrossSection.circle = function (i, s = 0) {
                    return o._Circle(i, s);
                });
            function g(i) {
                return function (...s) {
                    s.length == 1 && (s = s[0]);
                    const f = new o.Vector_crossSection();
                    for (const y of s) f.push_back(h(y));
                    const d = o["_crossSection" + i](f);
                    return f.delete(), d;
                };
            }
            (o.CrossSection.compose = g("Compose")), (o.CrossSection.union = g("UnionN")), (o.CrossSection.difference = g("DifferenceN")), (o.CrossSection.intersection = g("IntersectionN"));
            function P(i, s) {
                e(i, s, (f) => (f instanceof Array ? { x: f[0], y: f[1] } : f));
            }
            (o.CrossSection.hull = function (...i) {
                i.length == 1 && (i = i[0]);
                let s = new o.Vector_vec2();
                for (const d of i)
                    if (d instanceof v) o._crossSectionCollectVertices(s, d);
                    else if (d instanceof Array && d.length == 2 && typeof d[0] == "number") s.push_back({ x: d[0], y: d[1] });
                    else if (d.x) s.push_back(d);
                    else {
                        const b = (d[0].length == 2 && typeof d[0][0] == "number") || d[0].x ? [d] : d;
                        for (const w of b) P(s, w);
                    }
                const f = o._crossSectionHullPoints(s);
                return s.delete(), f;
            }),
                (o.CrossSection.prototype = Object.create(v.prototype)),
                Object.defineProperty(o.CrossSection, Symbol.hasInstance, { get: () => (i) => i instanceof v });
            const C = o.Manifold;
            (o.Manifold = function (i) {
                const s = new C(i),
                    f = s.status();
                if (f !== "NoError") throw new o.ManifoldError(f);
                return s;
            }),
                (o.Manifold.ofMesh = function (i) {
                    return new o.Manifold(i);
                }),
                (o.Manifold.tetrahedron = function () {
                    return o._Tetrahedron();
                }),
                (o.Manifold.cube = function (...i) {
                    let s;
                    i.length == 0 ? (s = { x: 1, y: 1, z: 1 }) : typeof i[0] == "number" ? (s = { x: i[0], y: i[0], z: i[0] }) : (s = l(i));
                    const f = i[1] || !1;
                    return o._Cube(s, f);
                }),
                (o.Manifold.cylinder = function (i, s, f = -1, d = 0, y = !1) {
                    return o._Cylinder(i, s, f, d, y);
                }),
                (o.Manifold.sphere = function (i, s = 0) {
                    return o._Sphere(i, s);
                }),
                (o.Manifold.smooth = function (i, s = []) {
                    const f = new o.Vector_smoothness();
                    e(f, s);
                    const d = o._Smooth(i, f);
                    return f.delete(), d;
                }),
                (o.Manifold.extrude = function (i, s, f = 0, d = 0, y = [1, 1], b = !1) {
                    return (i instanceof v ? i : o.CrossSection(i, "Positive")).extrude(s, f, d, y, b);
                }),
                (o.Manifold.revolve = function (i, s = 0, f = 360) {
                    return (i instanceof v ? i : o.CrossSection(i, "Positive")).revolve(s, f);
                }),
                (o.Manifold.reserveIDs = function (i) {
                    return o._ReserveIDs(i);
                }),
                (o.Manifold.compose = function (i) {
                    const s = new o.Vector_manifold();
                    e(s, i);
                    const f = o._manifoldCompose(s);
                    return s.delete(), f;
                });
            function R(i) {
                return function (...s) {
                    s.length == 1 && (s = s[0]);
                    const f = new o.Vector_manifold();
                    for (const y of s) f.push_back(y);
                    const d = o["_manifold" + i + "N"](f);
                    return f.delete(), d;
                };
            }
            (o.Manifold.union = R("Union")),
                (o.Manifold.difference = R("Difference")),
                (o.Manifold.intersection = R("Intersection")),
                (o.Manifold.levelSet = function (i, s, f, d = 0, y = -1) {
                    const b = { min: { x: s.min[0], y: s.min[1], z: s.min[2] }, max: { x: s.max[0], y: s.max[1], z: s.max[2] } },
                        w = le(function (S) {
                            const Y = k(S, "double"),
                                ee = k(S + 8, "double"),
                                T = k(S + 16, "double");
                            return i([Y, ee, T]);
                        }, "di"),
                        E = o._LevelSet(w, b, f, d, y);
                    return de(w), E;
                });
            function W(i, s) {
                e(i, s, (f) => (f instanceof Array ? { x: f[0], y: f[1], z: f[2] } : f));
            }
            (o.Manifold.hull = function (...i) {
                i.length == 1 && (i = i[0]);
                let s = new o.Vector_vec3();
                for (const d of i) d instanceof C ? o._manifoldCollectVertices(s, d) : d instanceof Array && d.length == 3 && typeof d[0] == "number" ? s.push_back({ x: d[0], y: d[1], z: d[2] }) : d.x ? s.push_back(d) : W(s, d);
                const f = o._manifoldHullPoints(s);
                return s.delete(), f;
            }),
                (o.Manifold.prototype = Object.create(C.prototype)),
                Object.defineProperty(o.Manifold, Symbol.hasInstance, { get: () => (i) => i instanceof C }),
                (o.triangulate = function (i, s = -1, f = !0) {
                    const d = n(i),
                        y = r(o._Triangulate(d, s, f), (b) => [b[0], b[1], b[2]]);
                    return a(d), y;
                });
        };
        var Ze = Object.assign({}, o),
            D = "";
        function Wr(e) {
            return o.locateFile ? o.locateFile(e, D) : D + e;
        }
        var Qe, Me;
        (Rr || Fe) &&
            (Fe ? (D = self.location.href) : typeof document < "u" && document.currentScript && (D = document.currentScript.src),
            qe && (D = qe),
            D.startsWith("blob:") ? (D = "") : (D = D.substr(0, D.replace(/[?#].*/, "").lastIndexOf("/") + 1)),
            Fe &&
                (Me = (e) => {
                    var r = new XMLHttpRequest();
                    return r.open("GET", e, !1), (r.responseType = "arraybuffer"), r.send(null), new Uint8Array(r.response);
                }),
            (Qe = (e) => fetch(e, { credentials: "same-origin" }).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status + " : " + r.url)))))),
            o.print || console.log.bind(console);
        var re = o.printErr || console.error.bind(console);
        Object.assign(o, Ze), (Ze = null), o.arguments && o.arguments, o.thisProgram && o.thisProgram, o.quit && o.quit;
        var te;
        o.wasmBinary && (te = o.wasmBinary);
        var pe,
            Xe = !1,
            V,
            M,
            H,
            ne,
            L,
            $,
            he,
            ye;
        function Ye() {
            var e = pe.buffer;
            (o.HEAP8 = V = new Int8Array(e)),
                (o.HEAP16 = H = new Int16Array(e)),
                (o.HEAPU8 = M = new Uint8Array(e)),
                (o.HEAPU16 = ne = new Uint16Array(e)),
                (o.HEAP32 = L = new Int32Array(e)),
                (o.HEAPU32 = $ = new Uint32Array(e)),
                (o.HEAPF32 = he = new Float32Array(e)),
                (o.HEAPF64 = ye = new Float64Array(e));
        }
        var er = [],
            rr = [],
            tr = [];
        function Er() {
            if (o.preRun) for (typeof o.preRun == "function" && (o.preRun = [o.preRun]); o.preRun.length; ) Ir(o.preRun.shift());
            Re(er);
        }
        function Vr() {
            Re(rr);
        }
        function kr() {
            if (o.postRun) for (typeof o.postRun == "function" && (o.postRun = [o.postRun]); o.postRun.length; ) Dr(o.postRun.shift());
            Re(tr);
        }
        function Ir(e) {
            er.unshift(e);
        }
        function Or(e) {
            rr.unshift(e);
        }
        function Dr(e) {
            tr.unshift(e);
        }
        var z = 0,
            ie = null;
        function xr(e) {
            z++, o.monitorRunDependencies?.(z);
        }
        function jr(e) {
            if ((z--, o.monitorRunDependencies?.(z), z == 0 && ie)) {
                var r = ie;
                (ie = null), r();
            }
        }
        function J(e) {
            o.onAbort?.(e), (e = "Aborted(" + e + ")"), re(e), (Xe = !0), (e += ". Build with -sASSERTIONS for more info.");
            var r = new WebAssembly.RuntimeError(e);
            throw (ve(r), r);
        }
        var Ur = "data:application/octet-stream;base64,",
            nr = (e) => e.startsWith(Ur);
        function Br() {
            if (o.locateFile) {
                var e = "manifold.wasm";
                return nr(e) ? e : Wr(e);
            }
            return new URL("/assets/manifold.wasm", self.location).href;
        }
        var _e;
        function ir(e) {
            if (e == _e && te) return new Uint8Array(te);
            if (Me) return Me(e);
            throw "both async and sync fetching of the wasm failed";
        }
        function Hr(e) {
            return te
                ? Promise.resolve().then(() => ir(e))
                : Qe(e).then(
                      (r) => new Uint8Array(r),
                      () => ir(e)
                  );
        }
        function or(e, r, t) {
            return Hr(e)
                .then((n) => WebAssembly.instantiate(n, r))
                .then(t, (n) => {
                    re(`failed to asynchronously prepare wasm: ${n}`), J(n);
                });
        }
        function Lr(e, r, t, n) {
            return !e && typeof WebAssembly.instantiateStreaming == "function" && !nr(r) && typeof fetch == "function"
                ? fetch(r, { credentials: "same-origin" }).then((a) => {
                      var u = WebAssembly.instantiateStreaming(a, t);
                      return u.then(n, function (l) {
                          return re(`wasm streaming compile failed: ${l}`), re("falling back to ArrayBuffer instantiation"), or(r, t, n);
                      });
                  })
                : or(r, t, n);
        }
        function zr() {
            return { a: An };
        }
        function Nr() {
            var e = zr();
            function r(n, a) {
                return (O = n.exports), (O = Sn(O)), (pe = O.J), Ye(), (X = O.M), Or(O.K), jr(), O;
            }
            xr();
            function t(n) {
                r(n.instance);
            }
            if (o.instantiateWasm)
                try {
                    return o.instantiateWasm(e, r);
                } catch (n) {
                    re(`Module.instantiateWasm callback failed with error: ${n}`), ve(n);
                }
            return _e || (_e = Br()), Lr(te, _e, e, t).catch(ve), {};
        }
        var Re = (e) => {
            for (; e.length > 0; ) e.shift()(o);
        };
        function k(e, r = "i8") {
            switch ((r.endsWith("*") && (r = "*"), r)) {
                case "i1":
                    return V[e >>> 0];
                case "i8":
                    return V[e >>> 0];
                case "i16":
                    return H[(e >>> 1) >>> 0];
                case "i32":
                    return L[(e >>> 2) >>> 0];
                case "i64":
                    J("to do getValue(i64) use WASM_BIGINT");
                case "float":
                    return he[(e >>> 2) >>> 0];
                case "double":
                    return ye[(e >>> 3) >>> 0];
                case "*":
                    return $[(e >>> 2) >>> 0];
                default:
                    J(`invalid type for getValue: ${r}`);
            }
        }
        o.noExitRuntime;
        function K(e, r, t = "i8") {
            switch ((t.endsWith("*") && (t = "*"), t)) {
                case "i1":
                    V[e >>> 0] = r;
                    break;
                case "i8":
                    V[e >>> 0] = r;
                    break;
                case "i16":
                    H[(e >>> 1) >>> 0] = r;
                    break;
                case "i32":
                    L[(e >>> 2) >>> 0] = r;
                    break;
                case "i64":
                    J("to do setValue(i64) use WASM_BIGINT");
                case "float":
                    he[(e >>> 2) >>> 0] = r;
                    break;
                case "double":
                    ye[(e >>> 3) >>> 0] = r;
                    break;
                case "*":
                    $[(e >>> 2) >>> 0] = r;
                    break;
                default:
                    J(`invalid type for setValue: ${t}`);
            }
        }
        class qr {
            constructor(r) {
                (this.excPtr = r), (this.ptr = r - 24);
            }
            set_type(r) {
                $[((this.ptr + 4) >>> 2) >>> 0] = r;
            }
            get_type() {
                return $[((this.ptr + 4) >>> 2) >>> 0];
            }
            set_destructor(r) {
                $[((this.ptr + 8) >>> 2) >>> 0] = r;
            }
            get_destructor() {
                return $[((this.ptr + 8) >>> 2) >>> 0];
            }
            set_caught(r) {
                (r = r ? 1 : 0), (V[(this.ptr + 12) >>> 0] = r);
            }
            get_caught() {
                return V[(this.ptr + 12) >>> 0] != 0;
            }
            set_rethrown(r) {
                (r = r ? 1 : 0), (V[(this.ptr + 13) >>> 0] = r);
            }
            get_rethrown() {
                return V[(this.ptr + 13) >>> 0] != 0;
            }
            init(r, t) {
                this.set_adjusted_ptr(0), this.set_type(r), this.set_destructor(t);
            }
            set_adjusted_ptr(r) {
                $[((this.ptr + 16) >>> 2) >>> 0] = r;
            }
            get_adjusted_ptr() {
                return $[((this.ptr + 16) >>> 2) >>> 0];
            }
            get_exception_ptr() {
                var r = Ar(this.get_type());
                if (r) return $[(this.excPtr >>> 2) >>> 0];
                var t = this.get_adjusted_ptr();
                return t !== 0 ? t : this.excPtr;
            }
        }
        var sr = 0;
        function Gr(e, r, t) {
            (e >>>= 0), (r >>>= 0), (t >>>= 0);
            var n = new qr(e);
            throw (n.init(r, t), (sr = e), sr);
        }
        var Jr = () => {
                J("");
            },
            me = {},
            We = (e) => {
                for (; e.length; ) {
                    var r = e.pop(),
                        t = e.pop();
                    t(r);
                }
            };
        function oe(e) {
            return this.fromWireType($[(e >>> 2) >>> 0]);
        }
        var Z = {},
            N = {},
            ge = {},
            ar,
            be = (e) => {
                throw new ar(e);
            },
            q = (e, r, t) => {
                e.forEach(function (c) {
                    ge[c] = r;
                });
                function n(c) {
                    var p = t(c);
                    p.length !== e.length && be("Mismatched type converter count");
                    for (var v = 0; v < e.length; ++v) x(e[v], p[v]);
                }
                var a = new Array(r.length),
                    u = [],
                    l = 0;
                r.forEach((c, p) => {
                    N.hasOwnProperty(c)
                        ? (a[p] = N[c])
                        : (u.push(c),
                          Z.hasOwnProperty(c) || (Z[c] = []),
                          Z[c].push(() => {
                              (a[p] = N[c]), ++l, l === u.length && n(a);
                          }));
                }),
                    u.length === 0 && n(a);
            },
            Kr = function (e) {
                e >>>= 0;
                var r = me[e];
                delete me[e];
                var t = r.rawConstructor,
                    n = r.rawDestructor,
                    a = r.fields,
                    u = a.map((l) => l.getterReturnType).concat(a.map((l) => l.setterArgumentType));
                q([e], u, (l) => {
                    var c = {};
                    return (
                        a.forEach((p, v) => {
                            var h = p.fieldName,
                                _ = l[v],
                                g = p.getter,
                                P = p.getterContext,
                                C = l[v + a.length],
                                R = p.setter,
                                W = p.setterContext;
                            c[h] = {
                                read: (i) => _.fromWireType(g(P, i)),
                                write: (i, s) => {
                                    var f = [];
                                    R(W, i, C.toWireType(f, s)), We(f);
                                },
                            };
                        }),
                        [
                            {
                                name: r.name,
                                fromWireType: (p) => {
                                    var v = {};
                                    for (var h in c) v[h] = c[h].read(p);
                                    return n(p), v;
                                },
                                toWireType: (p, v) => {
                                    for (var h in c) if (!(h in v)) throw new TypeError(`Missing field: "${h}"`);
                                    var _ = t();
                                    for (h in c) c[h].write(_, v[h]);
                                    return p !== null && p.push(n, _), _;
                                },
                                argPackAdvance: j,
                                readValueFromPointer: oe,
                                destructorFunction: n,
                            },
                        ]
                    );
                });
            };
        function Zr(e, r, t, n, a) {}
        var Qr = () => {
                for (var e = new Array(256), r = 0; r < 256; ++r) e[r] = String.fromCharCode(r);
                ur = e;
            },
            ur,
            F = (e) => {
                for (var r = "", t = e; M[t >>> 0]; ) r += ur[M[t++ >>> 0]];
                return r;
            },
            Q,
            m = (e) => {
                throw new Q(e);
            };
        function Xr(e, r, t = {}) {
            var n = r.name;
            if ((e || m(`type "${n}" must have a positive integer typeid pointer`), N.hasOwnProperty(e))) {
                if (t.ignoreDuplicateRegistrations) return;
                m(`Cannot register type '${n}' twice`);
            }
            if (((N[e] = r), delete ge[e], Z.hasOwnProperty(e))) {
                var a = Z[e];
                delete Z[e], a.forEach((u) => u());
            }
        }
        function x(e, r, t = {}) {
            if (!("argPackAdvance" in r)) throw new TypeError("registerType registeredInstance requires argPackAdvance");
            return Xr(e, r, t);
        }
        var j = 8;
        function Yr(e, r, t, n) {
            (e >>>= 0),
                (r >>>= 0),
                (r = F(r)),
                x(e, {
                    name: r,
                    fromWireType: function (a) {
                        return !!a;
                    },
                    toWireType: function (a, u) {
                        return u ? t : n;
                    },
                    argPackAdvance: j,
                    readValueFromPointer: function (a) {
                        return this.fromWireType(M[a >>> 0]);
                    },
                    destructorFunction: null,
                });
        }
        var et = (e) => ({ count: e.count, deleteScheduled: e.deleteScheduled, preservePointerOnDelete: e.preservePointerOnDelete, ptr: e.ptr, ptrType: e.ptrType, smartPtr: e.smartPtr, smartPtrType: e.smartPtrType }),
            Ee = (e) => {
                function r(t) {
                    return t.$$.ptrType.registeredClass.name;
                }
                m(r(e) + " instance already deleted");
            },
            Ve = !1,
            cr = (e) => {},
            rt = (e) => {
                e.smartPtr ? e.smartPtrType.rawDestructor(e.smartPtr) : e.ptrType.registeredClass.rawDestructor(e.ptr);
            },
            fr = (e) => {
                e.count.value -= 1;
                var r = e.count.value === 0;
                r && rt(e);
            },
            lr = (e, r, t) => {
                if (r === t) return e;
                if (t.baseClass === void 0) return null;
                var n = lr(e, r, t.baseClass);
                return n === null ? null : t.downcast(n);
            },
            dr = {},
            tt = () => Object.keys(ue).length,
            nt = () => {
                var e = [];
                for (var r in ue) ue.hasOwnProperty(r) && e.push(ue[r]);
                return e;
            },
            se = [],
            ke = () => {
                for (; se.length; ) {
                    var e = se.pop();
                    (e.$$.deleteScheduled = !1), e.delete();
                }
            },
            ae,
            it = (e) => {
                (ae = e), se.length && ae && ae(ke);
            },
            ot = () => {
                (o.getInheritedInstanceCount = tt), (o.getLiveInheritedInstances = nt), (o.flushPendingDeletes = ke), (o.setDelayFunction = it);
            },
            ue = {},
            st = (e, r) => {
                for (r === void 0 && m("ptr should not be undefined"); e.baseClass; ) (r = e.upcast(r)), (e = e.baseClass);
                return r;
            },
            at = (e, r) => ((r = st(e, r)), ue[r]),
            Pe = (e, r) => {
                (!r.ptrType || !r.ptr) && be("makeClassHandle requires ptr and ptrType");
                var t = !!r.smartPtrType,
                    n = !!r.smartPtr;
                return t !== n && be("Both smartPtrType and smartPtr must be specified"), (r.count = { value: 1 }), ce(Object.create(e, { $$: { value: r, writable: !0 } }));
            };
        function ut(e) {
            var r = this.getPointee(e);
            if (!r) return this.destructor(e), null;
            var t = at(this.registeredClass, r);
            if (t !== void 0) {
                if (t.$$.count.value === 0) return (t.$$.ptr = r), (t.$$.smartPtr = e), t.clone();
                var n = t.clone();
                return this.destructor(e), n;
            }
            function a() {
                return this.isSmartPointer ? Pe(this.registeredClass.instancePrototype, { ptrType: this.pointeeType, ptr: r, smartPtrType: this, smartPtr: e }) : Pe(this.registeredClass.instancePrototype, { ptrType: this, ptr: e });
            }
            var u = this.registeredClass.getActualType(r),
                l = dr[u];
            if (!l) return a.call(this);
            var c;
            this.isConst ? (c = l.constPointerType) : (c = l.pointerType);
            var p = lr(r, this.registeredClass, c.registeredClass);
            return p === null ? a.call(this) : this.isSmartPointer ? Pe(c.registeredClass.instancePrototype, { ptrType: c, ptr: p, smartPtrType: this, smartPtr: e }) : Pe(c.registeredClass.instancePrototype, { ptrType: c, ptr: p });
        }
        var ce = (e) =>
                typeof FinalizationRegistry > "u"
                    ? ((ce = (r) => r), e)
                    : ((Ve = new FinalizationRegistry((r) => {
                          fr(r.$$);
                      })),
                      (ce = (r) => {
                          var t = r.$$,
                              n = !!t.smartPtr;
                          if (n) {
                              var a = { $$: t };
                              Ve.register(r, a, r);
                          }
                          return r;
                      }),
                      (cr = (r) => Ve.unregister(r)),
                      ce(e)),
            ct = () => {
                Object.assign($e.prototype, {
                    isAliasOf(e) {
                        if (!(this instanceof $e) || !(e instanceof $e)) return !1;
                        var r = this.$$.ptrType.registeredClass,
                            t = this.$$.ptr;
                        e.$$ = e.$$;
                        for (var n = e.$$.ptrType.registeredClass, a = e.$$.ptr; r.baseClass; ) (t = r.upcast(t)), (r = r.baseClass);
                        for (; n.baseClass; ) (a = n.upcast(a)), (n = n.baseClass);
                        return r === n && t === a;
                    },
                    clone() {
                        if ((this.$$.ptr || Ee(this), this.$$.preservePointerOnDelete)) return (this.$$.count.value += 1), this;
                        var e = ce(Object.create(Object.getPrototypeOf(this), { $$: { value: et(this.$$) } }));
                        return (e.$$.count.value += 1), (e.$$.deleteScheduled = !1), e;
                    },
                    delete() {
                        this.$$.ptr || Ee(this),
                            this.$$.deleteScheduled && !this.$$.preservePointerOnDelete && m("Object already scheduled for deletion"),
                            cr(this),
                            fr(this.$$),
                            this.$$.preservePointerOnDelete || ((this.$$.smartPtr = void 0), (this.$$.ptr = void 0));
                    },
                    isDeleted() {
                        return !this.$$.ptr;
                    },
                    deleteLater() {
                        return (
                            this.$$.ptr || Ee(this),
                            this.$$.deleteScheduled && !this.$$.preservePointerOnDelete && m("Object already scheduled for deletion"),
                            se.push(this),
                            se.length === 1 && ae && ae(ke),
                            (this.$$.deleteScheduled = !0),
                            this
                        );
                    },
                });
            };
        function $e() {}
        var fe = (e, r) => Object.defineProperty(r, "name", { value: e }),
            vr = (e, r, t) => {
                if (e[r].overloadTable === void 0) {
                    var n = e[r];
                    (e[r] = function (...a) {
                        return (
                            e[r].overloadTable.hasOwnProperty(a.length) || m(`Function '${t}' called with an invalid number of arguments (${a.length}) - expects one of (${e[r].overloadTable})!`), e[r].overloadTable[a.length].apply(this, a)
                        );
                    }),
                        (e[r].overloadTable = []),
                        (e[r].overloadTable[n.argCount] = n);
                }
            },
            Ie = (e, r, t) => {
                o.hasOwnProperty(e)
                    ? ((t === void 0 || (o[e].overloadTable !== void 0 && o[e].overloadTable[t] !== void 0)) && m(`Cannot register public name '${e}' twice`),
                      vr(o, e, e),
                      o.hasOwnProperty(t) && m(`Cannot register multiple overloads of a function with the same number of arguments (${t})!`),
                      (o[e].overloadTable[t] = r))
                    : ((o[e] = r), t !== void 0 && (o[e].numArguments = t));
            },
            ft = 48,
            lt = 57,
            dt = (e) => {
                if (e === void 0) return "_unknown";
                e = e.replace(/[^a-zA-Z0-9_]/g, "$");
                var r = e.charCodeAt(0);
                return r >= ft && r <= lt ? `_${e}` : e;
            };
        function vt(e, r, t, n, a, u, l, c) {
            (this.name = e), (this.constructor = r), (this.instancePrototype = t), (this.rawDestructor = n), (this.baseClass = a), (this.getActualType = u), (this.upcast = l), (this.downcast = c), (this.pureVirtualFunctions = []);
        }
        var Oe = (e, r, t) => {
            for (; r !== t; ) r.upcast || m(`Expected null or instance of ${t.name}, got an instance of ${r.name}`), (e = r.upcast(e)), (r = r.baseClass);
            return e;
        };
        function pt(e, r) {
            if (r === null) return this.isReference && m(`null is not a valid ${this.name}`), 0;
            r.$$ || m(`Cannot pass "${Be(r)}" as a ${this.name}`), r.$$.ptr || m(`Cannot pass deleted object as a pointer of type ${this.name}`);
            var t = r.$$.ptrType.registeredClass,
                n = Oe(r.$$.ptr, t, this.registeredClass);
            return n;
        }
        function ht(e, r) {
            var t;
            if (r === null) return this.isReference && m(`null is not a valid ${this.name}`), this.isSmartPointer ? ((t = this.rawConstructor()), e !== null && e.push(this.rawDestructor, t), t) : 0;
            (!r || !r.$$) && m(`Cannot pass "${Be(r)}" as a ${this.name}`),
                r.$$.ptr || m(`Cannot pass deleted object as a pointer of type ${this.name}`),
                !this.isConst && r.$$.ptrType.isConst && m(`Cannot convert argument of type ${r.$$.smartPtrType ? r.$$.smartPtrType.name : r.$$.ptrType.name} to parameter type ${this.name}`);
            var n = r.$$.ptrType.registeredClass;
            if (((t = Oe(r.$$.ptr, n, this.registeredClass)), this.isSmartPointer))
                switch ((r.$$.smartPtr === void 0 && m("Passing raw pointer to smart pointer is illegal"), this.sharingPolicy)) {
                    case 0:
                        r.$$.smartPtrType === this ? (t = r.$$.smartPtr) : m(`Cannot convert argument of type ${r.$$.smartPtrType ? r.$$.smartPtrType.name : r.$$.ptrType.name} to parameter type ${this.name}`);
                        break;
                    case 1:
                        t = r.$$.smartPtr;
                        break;
                    case 2:
                        if (r.$$.smartPtrType === this) t = r.$$.smartPtr;
                        else {
                            var a = r.clone();
                            (t = this.rawShare(
                                t,
                                A.toHandle(() => a.delete())
                            )),
                                e !== null && e.push(this.rawDestructor, t);
                        }
                        break;
                    default:
                        m("Unsupporting sharing policy");
                }
            return t;
        }
        function yt(e, r) {
            if (r === null) return this.isReference && m(`null is not a valid ${this.name}`), 0;
            r.$$ || m(`Cannot pass "${Be(r)}" as a ${this.name}`),
                r.$$.ptr || m(`Cannot pass deleted object as a pointer of type ${this.name}`),
                r.$$.ptrType.isConst && m(`Cannot convert argument of type ${r.$$.ptrType.name} to parameter type ${this.name}`);
            var t = r.$$.ptrType.registeredClass,
                n = Oe(r.$$.ptr, t, this.registeredClass);
            return n;
        }
        var _t = () => {
            Object.assign(Ce.prototype, {
                getPointee(e) {
                    return this.rawGetPointee && (e = this.rawGetPointee(e)), e;
                },
                destructor(e) {
                    this.rawDestructor?.(e);
                },
                argPackAdvance: j,
                readValueFromPointer: oe,
                fromWireType: ut,
            });
        };
        function Ce(e, r, t, n, a, u, l, c, p, v, h) {
            (this.name = e),
                (this.registeredClass = r),
                (this.isReference = t),
                (this.isConst = n),
                (this.isSmartPointer = a),
                (this.pointeeType = u),
                (this.sharingPolicy = l),
                (this.rawGetPointee = c),
                (this.rawConstructor = p),
                (this.rawShare = v),
                (this.rawDestructor = h),
                !a && r.baseClass === void 0 ? (n ? ((this.toWireType = pt), (this.destructorFunction = null)) : ((this.toWireType = yt), (this.destructorFunction = null))) : (this.toWireType = ht);
        }
        var pr = (e, r, t) => {
                o.hasOwnProperty(e) || be("Replacing nonexistent public symbol"), o[e].overloadTable !== void 0 && t !== void 0 ? (o[e].overloadTable[t] = r) : ((o[e] = r), (o[e].argCount = t));
            },
            mt = (e, r, t) => {
                e = e.replace(/p/g, "i");
                var n = o["dynCall_" + e];
                return n(r, ...t);
            },
            X,
            we = (e) => X.get(e),
            gt = (e, r, t = []) => {
                if (e.includes("j")) return mt(e, r, t);
                var n = we(r)(...t);
                return e[0] == "p" ? n >>> 0 : n;
            },
            hr = (e, r) => (...t) => gt(e, r, t),
            I = (e, r) => {
                e = F(e);
                function t() {
                    return e.includes("j") || e.includes("p") ? hr(e, r) : we(r);
                }
                var n = t();
                return typeof n != "function" && m(`unknown function pointer with signature ${e}: ${r}`), n;
            },
            bt = (e, r) => {
                var t = fe(r, function (n) {
                    (this.name = r), (this.message = n);
                    var a = new Error(n).stack;
                    a !== void 0 &&
                        (this.stack =
                            this.toString() +
                            `
` +
                            a.replace(/^Error(:[^\n]*)?\n/, ""));
                });
                return (
                    (t.prototype = Object.create(e.prototype)),
                    (t.prototype.constructor = t),
                    (t.prototype.toString = function () {
                        return this.message === void 0 ? this.name : `${this.name}: ${this.message}`;
                    }),
                    t
                );
            },
            yr,
            _r = (e) => {
                var r = Tr(e),
                    t = F(r);
                return B(r), t;
            },
            Te = (e, r) => {
                var t = [],
                    n = {};
                function a(u) {
                    if (!n[u] && !N[u]) {
                        if (ge[u]) {
                            ge[u].forEach(a);
                            return;
                        }
                        t.push(u), (n[u] = !0);
                    }
                }
                throw (r.forEach(a), new yr(`${e}: ` + t.map(_r).join([", "])));
            };
        function Pt(e, r, t, n, a, u, l, c, p, v, h, _, g) {
            (e >>>= 0),
                (r >>>= 0),
                (t >>>= 0),
                (n >>>= 0),
                (a >>>= 0),
                (u >>>= 0),
                (l >>>= 0),
                (c >>>= 0),
                (p >>>= 0),
                (v >>>= 0),
                (h >>>= 0),
                (_ >>>= 0),
                (g >>>= 0),
                (h = F(h)),
                (u = I(a, u)),
                (c &&= I(l, c)),
                (v &&= I(p, v)),
                (g = I(_, g));
            var P = dt(h);
            Ie(P, function () {
                Te(`Cannot construct ${h} due to unbound types`, [n]);
            }),
                q([e, r, t], n ? [n] : [], (C) => {
                    C = C[0];
                    var R, W;
                    n ? ((R = C.registeredClass), (W = R.instancePrototype)) : (W = $e.prototype);
                    var i = fe(h, function (...w) {
                            if (Object.getPrototypeOf(this) !== s) throw new Q("Use 'new' to construct " + h);
                            if (f.constructor_body === void 0) throw new Q(h + " has no accessible constructor");
                            var E = f.constructor_body[w.length];
                            if (E === void 0) throw new Q(`Tried to invoke ctor of ${h} with invalid number of parameters (${w.length}) - expected (${Object.keys(f.constructor_body).toString()}) parameters instead!`);
                            return E.apply(this, w);
                        }),
                        s = Object.create(W, { constructor: { value: i } });
                    i.prototype = s;
                    var f = new vt(h, i, s, g, R, u, c, v);
                    f.baseClass && ((f.baseClass.__derivedClasses ??= []), f.baseClass.__derivedClasses.push(f));
                    var d = new Ce(h, f, !0, !1, !1),
                        y = new Ce(h + "*", f, !1, !1, !1),
                        b = new Ce(h + " const*", f, !1, !0, !1);
                    return (dr[e] = { pointerType: y, constPointerType: b }), pr(P, i), [d, y, b];
                });
        }
        var De = (e, r) => {
            for (var t = [], n = 0; n < e; n++) t.push($[((r + n * 4) >>> 2) >>> 0]);
            return t;
        };
        function $t(e) {
            for (var r = 1; r < e.length; ++r) if (e[r] !== null && e[r].destructorFunction === void 0) return !0;
            return !1;
        }
        function xe(e, r, t, n, a, u) {
            var l = r.length;
            l < 2 && m("argTypes array size mismatch! Must at least get return value and 'this' types!");
            var c = r[1] !== null && t !== null,
                p = $t(r),
                v = r[0].name !== "void",
                h = l - 2,
                _ = new Array(h),
                g = [],
                P = [],
                C = function (...R) {
                    R.length !== h && m(`function ${e} called with ${R.length} arguments, expected ${h}`), (P.length = 0);
                    var W;
                    (g.length = c ? 2 : 1), (g[0] = a), c && ((W = r[1].toWireType(P, this)), (g[1] = W));
                    for (var i = 0; i < h; ++i) (_[i] = r[i + 2].toWireType(P, R[i])), g.push(_[i]);
                    var s = n(...g);
                    function f(d) {
                        if (p) We(P);
                        else
                            for (var y = c ? 1 : 2; y < r.length; y++) {
                                var b = y === 1 ? W : _[y - 2];
                                r[y].destructorFunction !== null && r[y].destructorFunction(b);
                            }
                        if (v) return r[0].fromWireType(d);
                    }
                    return f(s);
                };
            return fe(e, C);
        }
        var Ct = function (e, r, t, n, a, u) {
                (e >>>= 0), (t >>>= 0), (n >>>= 0), (a >>>= 0), (u >>>= 0);
                var l = De(r, t);
                (a = I(n, a)),
                    q([], [e], (c) => {
                        c = c[0];
                        var p = `constructor ${c.name}`;
                        if ((c.registeredClass.constructor_body === void 0 && (c.registeredClass.constructor_body = []), c.registeredClass.constructor_body[r - 1] !== void 0))
                            throw new Q(
                                `Cannot register multiple constructors with identical number of parameters (${r - 1}) for class '${c.name}'! Overload resolution is currently only performed using the parameter count, not actual type info!`
                            );
                        return (
                            (c.registeredClass.constructor_body[r - 1] = () => {
                                Te(`Cannot construct ${c.name} due to unbound types`, l);
                            }),
                            q([], l, (v) => (v.splice(1, 0, null), (c.registeredClass.constructor_body[r - 1] = xe(p, v, null, a, u)), [])),
                            []
                        );
                    });
            },
            mr = (e) => {
                e = e.trim();
                const r = e.indexOf("(");
                return r !== -1 ? e.substr(0, r) : e;
            },
            wt = function (e, r, t, n, a, u, l, c, p) {
                (e >>>= 0), (r >>>= 0), (n >>>= 0), (a >>>= 0), (u >>>= 0), (l >>>= 0);
                var v = De(t, n);
                (r = F(r)),
                    (r = mr(r)),
                    (u = I(a, u)),
                    q([], [e], (h) => {
                        h = h[0];
                        var _ = `${h.name}.${r}`;
                        r.startsWith("@@") && (r = Symbol[r.substring(2)]), c && h.registeredClass.pureVirtualFunctions.push(r);
                        function g() {
                            Te(`Cannot call ${_} due to unbound types`, v);
                        }
                        var P = h.registeredClass.instancePrototype,
                            C = P[r];
                        return (
                            C === void 0 || (C.overloadTable === void 0 && C.className !== h.name && C.argCount === t - 2) ? ((g.argCount = t - 2), (g.className = h.name), (P[r] = g)) : (vr(P, r, _), (P[r].overloadTable[t - 2] = g)),
                            q([], v, (R) => {
                                var W = xe(_, R, h, u, l);
                                return P[r].overloadTable === void 0 ? ((W.argCount = t - 2), (P[r] = W)) : (P[r].overloadTable[t - 2] = W), [];
                            }),
                            []
                        );
                    });
            },
            je = [],
            U = [];
        function Ue(e) {
            (e >>>= 0), e > 9 && --U[e + 1] === 0 && ((U[e] = void 0), je.push(e));
        }
        var Tt = () => U.length / 2 - 5 - je.length,
            At = () => {
                U.push(0, 1, void 0, 1, null, 1, !0, 1, !1, 1), (o.count_emval_handles = Tt);
            },
            A = {
                toValue: (e) => (e || m("Cannot use deleted val. handle = " + e), U[e]),
                toHandle: (e) => {
                    switch (e) {
                        case void 0:
                            return 2;
                        case null:
                            return 4;
                        case !0:
                            return 6;
                        case !1:
                            return 8;
                        default: {
                            const r = je.pop() || U.length;
                            return (U[r] = e), (U[r + 1] = 1), r;
                        }
                    }
                },
            },
            St = {
                name: "emscripten::val",
                fromWireType: (e) => {
                    var r = A.toValue(e);
                    return Ue(e), r;
                },
                toWireType: (e, r) => A.toHandle(r),
                argPackAdvance: j,
                readValueFromPointer: oe,
                destructorFunction: null,
            };
        function gr(e) {
            return (e >>>= 0), x(e, St);
        }
        var Ft = (e, r, t) => {
            switch (r) {
                case 1:
                    return t
                        ? function (n) {
                              return this.fromWireType(V[n >>> 0]);
                          }
                        : function (n) {
                              return this.fromWireType(M[n >>> 0]);
                          };
                case 2:
                    return t
                        ? function (n) {
                              return this.fromWireType(H[(n >>> 1) >>> 0]);
                          }
                        : function (n) {
                              return this.fromWireType(ne[(n >>> 1) >>> 0]);
                          };
                case 4:
                    return t
                        ? function (n) {
                              return this.fromWireType(L[(n >>> 2) >>> 0]);
                          }
                        : function (n) {
                              return this.fromWireType($[(n >>> 2) >>> 0]);
                          };
                default:
                    throw new TypeError(`invalid integer width (${r}): ${e}`);
            }
        };
        function Mt(e, r, t, n) {
            (e >>>= 0), (r >>>= 0), (t >>>= 0), (r = F(r));
            function a() {}
            (a.values = {}),
                x(e, {
                    name: r,
                    constructor: a,
                    fromWireType: function (u) {
                        return this.constructor.values[u];
                    },
                    toWireType: (u, l) => l.value,
                    argPackAdvance: j,
                    readValueFromPointer: Ft(r, t, n),
                    destructorFunction: null,
                }),
                Ie(r, a);
        }
        var Ae = (e, r) => {
            var t = N[e];
            return t === void 0 && m(`${r} has unknown type ${_r(e)}`), t;
        };
        function Rt(e, r, t) {
            (e >>>= 0), (r >>>= 0);
            var n = Ae(e, "enum");
            r = F(r);
            var a = n.constructor,
                u = Object.create(n.constructor.prototype, { value: { value: t }, constructor: { value: fe(`${n.name}_${r}`, function () {}) } });
            (a.values[t] = u), (a[r] = u);
        }
        var Be = (e) => {
                if (e === null) return "null";
                var r = typeof e;
                return r === "object" || r === "array" || r === "function" ? e.toString() : "" + e;
            },
            Wt = (e, r) => {
                switch (r) {
                    case 4:
                        return function (t) {
                            return this.fromWireType(he[(t >>> 2) >>> 0]);
                        };
                    case 8:
                        return function (t) {
                            return this.fromWireType(ye[(t >>> 3) >>> 0]);
                        };
                    default:
                        throw new TypeError(`invalid float width (${r}): ${e}`);
                }
            },
            Et = function (e, r, t) {
                (e >>>= 0), (r >>>= 0), (t >>>= 0), (r = F(r)), x(e, { name: r, fromWireType: (n) => n, toWireType: (n, a) => a, argPackAdvance: j, readValueFromPointer: Wt(r, t), destructorFunction: null });
            };
        function Vt(e, r, t, n, a, u, l) {
            (e >>>= 0), (t >>>= 0), (n >>>= 0), (a >>>= 0), (u >>>= 0);
            var c = De(r, t);
            (e = F(e)),
                (e = mr(e)),
                (a = I(n, a)),
                Ie(
                    e,
                    function () {
                        Te(`Cannot call ${e} due to unbound types`, c);
                    },
                    r - 1
                ),
                q([], c, (p) => {
                    var v = [p[0], null].concat(p.slice(1));
                    return pr(e, xe(e, v, null, a, u), r - 1), [];
                });
        }
        var kt = (e, r, t) => {
            switch (r) {
                case 1:
                    return t ? (n) => V[n >>> 0] : (n) => M[n >>> 0];
                case 2:
                    return t ? (n) => H[(n >>> 1) >>> 0] : (n) => ne[(n >>> 1) >>> 0];
                case 4:
                    return t ? (n) => L[(n >>> 2) >>> 0] : (n) => $[(n >>> 2) >>> 0];
                default:
                    throw new TypeError(`invalid integer width (${r}): ${e}`);
            }
        };
        function It(e, r, t, n, a) {
            (e >>>= 0), (r >>>= 0), (t >>>= 0), (r = F(r));
            var u = (h) => h;
            if (n === 0) {
                var l = 32 - 8 * t;
                u = (h) => (h << l) >>> l;
            }
            var c = r.includes("unsigned"),
                p = (h, _) => {},
                v;
            c
                ? (v = function (h, _) {
                      return p(_, this.name), _ >>> 0;
                  })
                : (v = function (h, _) {
                      return p(_, this.name), _;
                  }),
                x(e, { name: r, fromWireType: u, toWireType: v, argPackAdvance: j, readValueFromPointer: kt(r, t, n !== 0), destructorFunction: null });
        }
        function Ot(e, r, t) {
            (e >>>= 0), (t >>>= 0);
            var n = [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array],
                a = n[r];
            function u(l) {
                var c = $[(l >>> 2) >>> 0],
                    p = $[((l + 4) >>> 2) >>> 0];
                return new a(V.buffer, p, c);
            }
            (t = F(t)), x(e, { name: t, fromWireType: u, argPackAdvance: j, readValueFromPointer: u }, { ignoreDuplicateRegistrations: !0 });
        }
        function Dt(e, r) {
            (e >>>= 0), gr(e);
        }
        var xt = (e, r, t, n) => {
                if (((t >>>= 0), !(n > 0))) return 0;
                for (var a = t, u = t + n - 1, l = 0; l < e.length; ++l) {
                    var c = e.charCodeAt(l);
                    if (c >= 55296 && c <= 57343) {
                        var p = e.charCodeAt(++l);
                        c = (65536 + ((c & 1023) << 10)) | (p & 1023);
                    }
                    if (c <= 127) {
                        if (t >= u) break;
                        r[t++ >>> 0] = c;
                    } else if (c <= 2047) {
                        if (t + 1 >= u) break;
                        (r[t++ >>> 0] = 192 | (c >> 6)), (r[t++ >>> 0] = 128 | (c & 63));
                    } else if (c <= 65535) {
                        if (t + 2 >= u) break;
                        (r[t++ >>> 0] = 224 | (c >> 12)), (r[t++ >>> 0] = 128 | ((c >> 6) & 63)), (r[t++ >>> 0] = 128 | (c & 63));
                    } else {
                        if (t + 3 >= u) break;
                        (r[t++ >>> 0] = 240 | (c >> 18)), (r[t++ >>> 0] = 128 | ((c >> 12) & 63)), (r[t++ >>> 0] = 128 | ((c >> 6) & 63)), (r[t++ >>> 0] = 128 | (c & 63));
                    }
                }
                return (r[t >>> 0] = 0), t - a;
            },
            jt = (e, r, t) => xt(e, M, r, t),
            Ut = (e) => {
                for (var r = 0, t = 0; t < e.length; ++t) {
                    var n = e.charCodeAt(t);
                    n <= 127 ? r++ : n <= 2047 ? (r += 2) : n >= 55296 && n <= 57343 ? ((r += 4), ++t) : (r += 3);
                }
                return r;
            },
            br = typeof TextDecoder < "u" ? new TextDecoder() : void 0,
            Bt = (e, r, t) => {
                r >>>= 0;
                for (var n = r + t, a = r; e[a] && !(a >= n); ) ++a;
                if (a - r > 16 && e.buffer && br) return br.decode(e.subarray(r, a));
                for (var u = ""; r < a; ) {
                    var l = e[r++];
                    if (!(l & 128)) {
                        u += String.fromCharCode(l);
                        continue;
                    }
                    var c = e[r++] & 63;
                    if ((l & 224) == 192) {
                        u += String.fromCharCode(((l & 31) << 6) | c);
                        continue;
                    }
                    var p = e[r++] & 63;
                    if (((l & 240) == 224 ? (l = ((l & 15) << 12) | (c << 6) | p) : (l = ((l & 7) << 18) | (c << 12) | (p << 6) | (e[r++] & 63)), l < 65536)) u += String.fromCharCode(l);
                    else {
                        var v = l - 65536;
                        u += String.fromCharCode(55296 | (v >> 10), 56320 | (v & 1023));
                    }
                }
                return u;
            },
            Ht = (e, r) => ((e >>>= 0), e ? Bt(M, e, r) : "");
        function Lt(e, r) {
            (e >>>= 0), (r >>>= 0), (r = F(r));
            var t = r === "std::string";
            x(e, {
                name: r,
                fromWireType(n) {
                    var a = $[(n >>> 2) >>> 0],
                        u = n + 4,
                        l;
                    if (t)
                        for (var c = u, p = 0; p <= a; ++p) {
                            var v = u + p;
                            if (p == a || M[v >>> 0] == 0) {
                                var h = v - c,
                                    _ = Ht(c, h);
                                l === void 0 ? (l = _) : ((l += String.fromCharCode(0)), (l += _)), (c = v + 1);
                            }
                        }
                    else {
                        for (var g = new Array(a), p = 0; p < a; ++p) g[p] = String.fromCharCode(M[(u + p) >>> 0]);
                        l = g.join("");
                    }
                    return B(n), l;
                },
                toWireType(n, a) {
                    a instanceof ArrayBuffer && (a = new Uint8Array(a));
                    var u,
                        l = typeof a == "string";
                    l || a instanceof Uint8Array || a instanceof Uint8ClampedArray || a instanceof Int8Array || m("Cannot pass non-string to std::string"), t && l ? (u = Ut(a)) : (u = a.length);
                    var c = Ne(4 + u + 1),
                        p = c + 4;
                    if ((($[(c >>> 2) >>> 0] = u), t && l)) jt(a, p, u + 1);
                    else if (l)
                        for (var v = 0; v < u; ++v) {
                            var h = a.charCodeAt(v);
                            h > 255 && (B(p), m("String has UTF-16 code units that do not fit in 8 bits")), (M[(p + v) >>> 0] = h);
                        }
                    else for (var v = 0; v < u; ++v) M[(p + v) >>> 0] = a[v];
                    return n !== null && n.push(B, c), c;
                },
                argPackAdvance: j,
                readValueFromPointer: oe,
                destructorFunction(n) {
                    B(n);
                },
            });
        }
        var Pr = typeof TextDecoder < "u" ? new TextDecoder("utf-16le") : void 0,
            zt = (e, r) => {
                for (var t = e, n = t >> 1, a = n + r / 2; !(n >= a) && ne[n >>> 0]; ) ++n;
                if (((t = n << 1), t - e > 32 && Pr)) return Pr.decode(M.subarray(e >>> 0, t >>> 0));
                for (var u = "", l = 0; !(l >= r / 2); ++l) {
                    var c = H[((e + l * 2) >>> 1) >>> 0];
                    if (c == 0) break;
                    u += String.fromCharCode(c);
                }
                return u;
            },
            Nt = (e, r, t) => {
                if (((t ??= 2147483647), t < 2)) return 0;
                t -= 2;
                for (var n = r, a = t < e.length * 2 ? t / 2 : e.length, u = 0; u < a; ++u) {
                    var l = e.charCodeAt(u);
                    (H[(r >>> 1) >>> 0] = l), (r += 2);
                }
                return (H[(r >>> 1) >>> 0] = 0), r - n;
            },
            qt = (e) => e.length * 2,
            Gt = (e, r) => {
                for (var t = 0, n = ""; !(t >= r / 4); ) {
                    var a = L[((e + t * 4) >>> 2) >>> 0];
                    if (a == 0) break;
                    if ((++t, a >= 65536)) {
                        var u = a - 65536;
                        n += String.fromCharCode(55296 | (u >> 10), 56320 | (u & 1023));
                    } else n += String.fromCharCode(a);
                }
                return n;
            },
            Jt = (e, r, t) => {
                if (((r >>>= 0), (t ??= 2147483647), t < 4)) return 0;
                for (var n = r, a = n + t - 4, u = 0; u < e.length; ++u) {
                    var l = e.charCodeAt(u);
                    if (l >= 55296 && l <= 57343) {
                        var c = e.charCodeAt(++u);
                        l = (65536 + ((l & 1023) << 10)) | (c & 1023);
                    }
                    if (((L[(r >>> 2) >>> 0] = l), (r += 4), r + 4 > a)) break;
                }
                return (L[(r >>> 2) >>> 0] = 0), r - n;
            },
            Kt = (e) => {
                for (var r = 0, t = 0; t < e.length; ++t) {
                    var n = e.charCodeAt(t);
                    n >= 55296 && n <= 57343 && ++t, (r += 4);
                }
                return r;
            },
            Zt = function (e, r, t) {
                (e >>>= 0), (r >>>= 0), (t >>>= 0), (t = F(t));
                var n, a, u, l;
                r === 2 ? ((n = zt), (a = Nt), (l = qt), (u = (c) => ne[(c >>> 1) >>> 0])) : r === 4 && ((n = Gt), (a = Jt), (l = Kt), (u = (c) => $[(c >>> 2) >>> 0])),
                    x(e, {
                        name: t,
                        fromWireType: (c) => {
                            for (var p = $[(c >>> 2) >>> 0], v, h = c + 4, _ = 0; _ <= p; ++_) {
                                var g = c + 4 + _ * r;
                                if (_ == p || u(g) == 0) {
                                    var P = g - h,
                                        C = n(h, P);
                                    v === void 0 ? (v = C) : ((v += String.fromCharCode(0)), (v += C)), (h = g + r);
                                }
                            }
                            return B(c), v;
                        },
                        toWireType: (c, p) => {
                            typeof p != "string" && m(`Cannot pass non-string to C++ string type ${t}`);
                            var v = l(p),
                                h = Ne(4 + v + r);
                            return ($[(h >>> 2) >>> 0] = v / r), a(p, h + 4, v + r), c !== null && c.push(B, h), h;
                        },
                        argPackAdvance: j,
                        readValueFromPointer: oe,
                        destructorFunction(c) {
                            B(c);
                        },
                    });
            };
        function Qt(e, r, t, n, a, u) {
            (e >>>= 0), (r >>>= 0), (t >>>= 0), (n >>>= 0), (a >>>= 0), (u >>>= 0), (me[e] = { name: F(r), rawConstructor: I(t, n), rawDestructor: I(a, u), fields: [] });
        }
        function Xt(e, r, t, n, a, u, l, c, p, v) {
            (e >>>= 0),
                (r >>>= 0),
                (t >>>= 0),
                (n >>>= 0),
                (a >>>= 0),
                (u >>>= 0),
                (l >>>= 0),
                (c >>>= 0),
                (p >>>= 0),
                (v >>>= 0),
                me[e].fields.push({ fieldName: F(r), getterReturnType: t, getter: I(n, a), getterContext: u, setterArgumentType: l, setter: I(c, p), setterContext: v });
        }
        var Yt = function (e, r) {
            (e >>>= 0), (r >>>= 0), (r = F(r)), x(e, { isVoid: !0, name: r, argPackAdvance: 0, fromWireType: () => {}, toWireType: (t, n) => {} });
        };
        function en(e, r, t) {
            return (e >>>= 0), (r >>>= 0), (t >>>= 0), M.copyWithin(e >>> 0, r >>> 0, (r + t) >>> 0);
        }
        var $r = (e, r, t) => {
            var n = [],
                a = e.toWireType(n, t);
            return n.length && ($[(r >>> 2) >>> 0] = A.toHandle(n)), a;
        };
        function rn(e, r, t) {
            return (e >>>= 0), (r >>>= 0), (t >>>= 0), (e = A.toValue(e)), (r = Ae(r, "emval::as")), $r(r, t, e);
        }
        var tn = {},
            Cr = (e) => {
                var r = tn[e];
                return r === void 0 ? F(e) : r;
            },
            He = [];
        function nn(e, r, t, n, a) {
            return (e >>>= 0), (r >>>= 0), (t >>>= 0), (n >>>= 0), (a >>>= 0), (e = He[e]), (r = A.toValue(r)), (t = Cr(t)), e(r, r[t], n, a);
        }
        function on(e, r) {
            return (e >>>= 0), (r >>>= 0), (e = A.toValue(e)), (r = A.toValue(r)), e == r;
        }
        var sn = (e) => {
                var r = He.length;
                return He.push(e), r;
            },
            an = (e, r) => {
                for (var t = new Array(e), n = 0; n < e; ++n) t[n] = Ae($[((r + n * 4) >>> 2) >>> 0], "parameter " + n);
                return t;
            },
            un = Reflect.construct,
            cn = function (e, r, t) {
                r >>>= 0;
                var n = an(e, r),
                    a = n.shift();
                e--;
                var u = new Array(e),
                    l = (p, v, h, _) => {
                        for (var g = 0, P = 0; P < e; ++P) (u[P] = n[P].readValueFromPointer(_ + g)), (g += n[P].argPackAdvance);
                        var C = t === 1 ? un(v, u) : v.apply(p, u);
                        return $r(a, h, C);
                    },
                    c = `methodCaller<(${n.map((p) => p.name).join(", ")}) => ${a.name}>`;
                return sn(fe(c, l));
            };
        function fn(e, r) {
            return (e >>>= 0), (r >>>= 0), (e = A.toValue(e)), (r = A.toValue(r)), A.toHandle(e[r]);
        }
        function ln(e) {
            (e >>>= 0), e > 9 && (U[e + 1] += 1);
        }
        function dn(e) {
            return (e >>>= 0), A.toHandle(Cr(e));
        }
        function vn() {
            return A.toHandle({});
        }
        function pn(e) {
            e >>>= 0;
            var r = A.toValue(e);
            We(r), Ue(e);
        }
        function hn(e, r, t) {
            (e >>>= 0), (r >>>= 0), (t >>>= 0), (e = A.toValue(e)), (r = A.toValue(r)), (t = A.toValue(t)), (e[r] = t);
        }
        function yn(e, r) {
            (e >>>= 0), (r >>>= 0), (e = Ae(e, "_emval_take_value"));
            var t = e.readValueFromPointer(r);
            return A.toHandle(t);
        }
        var _n = () => 4294901760,
            mn = (e) => {
                var r = pe.buffer,
                    t = (e - r.byteLength + 65535) / 65536;
                try {
                    return pe.grow(t), Ye(), 1;
                } catch {}
            };
        function gn(e) {
            e >>>= 0;
            var r = M.length,
                t = _n();
            if (e > t) return !1;
            for (var n = (p, v) => p + ((v - (p % v)) % v), a = 1; a <= 4; a *= 2) {
                var u = r * (1 + 0.2 / a);
                u = Math.min(u, e + 100663296);
                var l = Math.min(t, n(Math.max(e, u), 65536)),
                    c = mn(l);
                if (c) return !0;
            }
            return !1;
        }
        var wr = (e, r) => {
                e < 128 ? r.push(e) : r.push(e % 128 | 128, e >> 7);
            },
            bn = (e) => {
                for (var r = { i: "i32", j: "i64", f: "f32", d: "f64", e: "externref", p: "i32" }, t = { parameters: [], results: e[0] == "v" ? [] : [r[e[0]]] }, n = 1; n < e.length; ++n) t.parameters.push(r[e[n]]);
                return t;
            },
            Pn = (e, r) => {
                var t = e.slice(0, 1),
                    n = e.slice(1),
                    a = { i: 127, p: 127, j: 126, f: 125, d: 124, e: 111 };
                r.push(96), wr(n.length, r);
                for (var u = 0; u < n.length; ++u) r.push(a[n[u]]);
                t == "v" ? r.push(0) : r.push(1, a[t]);
            },
            $n = (e, r) => {
                if (typeof WebAssembly.Function == "function") return new WebAssembly.Function(bn(r), e);
                var t = [1];
                Pn(r, t);
                var n = [0, 97, 115, 109, 1, 0, 0, 0, 1];
                wr(t.length, n), n.push(...t), n.push(2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0);
                var a = new WebAssembly.Module(new Uint8Array(n)),
                    u = new WebAssembly.Instance(a, { e: { f: e } }),
                    l = u.exports.f;
                return l;
            },
            Cn = (e, r) => {
                if (G)
                    for (var t = e; t < e + r; t++) {
                        var n = we(t);
                        n && G.set(n, t);
                    }
            },
            G,
            wn = (e) => (G || ((G = new WeakMap()), Cn(0, X.length)), G.get(e) || 0),
            Le = [],
            Tn = () => {
                if (Le.length) return Le.pop();
                try {
                    X.grow(1);
                } catch (e) {
                    throw e instanceof RangeError ? "Unable to grow wasm table. Set ALLOW_TABLE_GROWTH." : e;
                }
                return X.length - 1;
            },
            ze = (e, r) => X.set(e, r),
            le = (e, r) => {
                var t = wn(e);
                if (t) return t;
                var n = Tn();
                try {
                    ze(n, e);
                } catch (u) {
                    if (!(u instanceof TypeError)) throw u;
                    var a = $n(e, r);
                    ze(n, a);
                }
                return G.set(e, n), n;
            },
            de = (e) => {
                G.delete(we(e)), ze(e, null), Le.push(e);
            };
        (ar = o.InternalError = class extends Error {
            constructor(r) {
                super(r), (this.name = "InternalError");
            }
        }),
            Qr(),
            (Q = o.BindingError = class extends Error {
                constructor(r) {
                    super(r), (this.name = "BindingError");
                }
            }),
            ct(),
            ot(),
            _t(),
            (yr = o.UnboundTypeError = bt(Error, "UnboundTypeError")),
            At();
        var An = {
                i: Gr,
                D: Jr,
                n: Kr,
                C: Zr,
                H: Yr,
                h: Pt,
                g: Ct,
                a: wt,
                G: gr,
                t: Mt,
                e: Rt,
                x: Et,
                c: Vt,
                j: It,
                f: Ot,
                k: Dt,
                w: Lt,
                s: Zt,
                o: Qt,
                l: Xt,
                I: Yt,
                F: en,
                v: rn,
                z: nn,
                b: Ue,
                m: on,
                y: cn,
                B: fn,
                u: ln,
                q: dn,
                A: vn,
                p: pn,
                r: hn,
                d: yn,
                E: gn,
            },
            O = Nr(),
            Tr = (e) => (Tr = O.L)(e),
            Ne = (e) => (Ne = O.N)(e),
            B = (e) => (B = O.O)(e),
            Ar = (e) => (Ar = O.P)(e);
        function Sn(e) {
            e = Object.assign({}, e);
            var r = (n) => (a) => n(a) >>> 0,
                t = (n) => () => n() >>> 0;
            return (e.L = r(e.L)), (e.N = r(e.N)), (e._emscripten_stack_alloc = r(e._emscripten_stack_alloc)), (e.emscripten_stack_get_current = t(e.emscripten_stack_get_current)), e;
        }
        (o.addFunction = le), (o.removeFunction = de);
        var Se;
        ie = function e() {
            Se || Sr(), Se || (ie = e);
        };
        function Sr() {
            if (z > 0 || (Er(), z > 0)) return;
            function e() {
                Se || ((Se = !0), (o.calledRun = !0), !Xe && (Vr(), Je(o), o.onRuntimeInitialized?.(), kr()));
            }
            o.setStatus
                ? (o.setStatus("Running..."),
                  setTimeout(function () {
                      setTimeout(function () {
                          o.setStatus("");
                      }, 1),
                          e();
                  }, 1))
                : e();
        }
        if (o.preInit) for (typeof o.preInit == "function" && (o.preInit = [o.preInit]); o.preInit.length > 0; ) o.preInit.pop()();
        return Sr(), (Ge = Mr), Ge;
    };
})();
export { Mn as M };
