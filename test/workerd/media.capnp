using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (services = [(name = "media", worker = (
  modules = [
    (name = "test.js", esModule = embed "media.js"),
    (name = "src/weixin.js", esModule = embed "../../src/weixin.js"),
    (name = "src/http.js", esModule = embed "../../src/http.js")
  ],
  compatibilityDate = "2026-10-21",
  compatibilityFlags = ["nodejs_compat"]
))]);
