export const CLIENTS_REGISTRY = [
    {
        id: "kicksmanina",
        name: "Kicksmania",
        allowedCategory: "shoes",
        allowedSites: "all" // They get everything in the shoes database
    },
    {
        id: "timeskeeper",
        name: "Timeskeeper",
        allowedCategory: "watches",
        allowedSites: "all" // They get everything in the watches database
    },
    {
        id: "thequwawatch",
        name: "Thequwawatch",
        allowedCategory: "watches",
        // They only get these specific manufacturers
        allowedSites: ["mangoenterprise", "zeewatches", "watchhouse11"] 
    }
];