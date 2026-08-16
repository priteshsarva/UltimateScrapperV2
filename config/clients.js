export const CLIENT_CONFIGS = {
    "timekeepers.in": {
        name: "TimeKeepers",
        access: [
            { database: "watches", manufacturers: "all" },
        ]
    },
    "kicksmania.co.in": {
        name: "Kicksmania",
        access: [
            { database: "shoes", manufacturers: "all" }
        ]
    },
    "theaquawatch.com": {
        name: "TheAquaWatch",
        access: [
            { database: "watches", manufacturers: "all" },
            { database: "shoes", manufacturers: "all" }
        ]
    }
    // "stylenova.co.in" removed 2026-08 — off direct-push, DNS dead.
};