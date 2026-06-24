import axios from 'axios';

const API_BASE = "http://localhost/api";

async function runStressTest() {
    console.log("🚀 Starting Phase 5 Stress Test...");

    // We will fire 50 requests at the exact same time
    const requests = [];

    for (let i = 0; i < 25; i++) {
        // Simulating requests to the Shoes DB
        requests.push(axios.get(`${API_BASE}/shoes/allresults`).catch(e => e.message));
        // Simulating requests to the Watches DB
        requests.push(axios.get(`${API_BASE}/watches/allresults`).catch(e => e.message));
    }

    console.log(`📡 Firing ${requests.length} parallel requests...`);

    const start = Date.now();
    const results = await Promise.all(requests);
    const end = Date.now();

    const success = results.filter(r => typeof r === 'object').length;
    const failed = results.filter(r => typeof r === 'string').length;

    console.log("\n--- Stress Test Results ---");
    console.log(`⏱ Total Time: ${end - start}ms`);
    console.log(`✅ Successful Requests: ${success}`);
    console.log(`❌ Failed Requests: ${failed}`);

    if (failed > 0) {
        console.log("⚠️ Warning: Some requests failed. We may need to optimize DB connections.");
    } else {
        console.log("💎 Perfect: The Multi-DB system is stable under parallel load.");
    }
}

runStressTest();