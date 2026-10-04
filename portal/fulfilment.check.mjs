// Self-check for the one branchy rule in fulfilmentRoutes: when parcel photos are
// mandatory. Photos protect money the platform HOLDS; without a hold, a courier
// tracking number is enough (a vendor shipping via JD Web & Ship / Selloship has
// an AWB, not photos).  Run: node portal/fulfilment.check.mjs
import assert from "node:assert/strict";
import { shipmentProofOk } from "./fulfilmentRoutes.js";

// money held -> photos, and only photos, will do
assert.equal(shipmentProofOk({ photoCount: 2, heldAmount: 500 }).ok, true);
assert.equal(shipmentProofOk({ photoCount: 1, heldAmount: 500 }).ok, false);
assert.equal(shipmentProofOk({ photoCount: 0, trackingNo: "AWB123", heldAmount: 500 }).ok, false,
  "tracking must NOT buy a release of held money");

// nothing held -> tracking alone is fine, photos alone are fine
assert.equal(shipmentProofOk({ trackingNo: "AWB123", heldAmount: 0 }).ok, true);
assert.equal(shipmentProofOk({ photoCount: 2, heldAmount: 0 }).ok, true);
assert.equal(shipmentProofOk({ photoCount: 0, heldAmount: 0 }).ok, false, "needs something");
assert.equal(shipmentProofOk({ trackingNo: "   ", heldAmount: 0 }).ok, false, "blank tracking is not tracking");
assert.equal(shipmentProofOk({ photoCount: 1, heldAmount: 0 }).ok, false, "1 photo and no tracking is neither");

// hard ceiling regardless
assert.equal(shipmentProofOk({ photoCount: 11, trackingNo: "AWB", heldAmount: 0 }).ok, false);

console.log("fulfilment.check: all assertions passed");
