const fs = require("node:fs");

const KNOWN_FAST_XML_ADVISORIES = new Set([
  "https://github.com/advisories/GHSA-jmr7-xgp7-cmfj",
  "https://github.com/advisories/GHSA-37qj-frw5-hhjh"
]);

function readStdin() {
  return fs.readFileSync(0, "utf8").trim();
}

function isKnownAwsXmlChain(vulnerability) {
  if (vulnerability.severity !== "high") return false;

  const packageName = vulnerability.name || "";
  if (!packageName.startsWith("@aws-sdk/") && packageName !== "fast-xml-parser") {
    return false;
  }

  const via = Array.isArray(vulnerability.via) ? vulnerability.via : [];
  return via.every((item) => {
    if (typeof item === "string") {
      return item.startsWith("@aws-sdk/") || item === "fast-xml-parser";
    }

    if (item && typeof item === "object") {
      return (
        item.name === "fast-xml-parser" &&
        KNOWN_FAST_XML_ADVISORIES.has(item.url)
      );
    }

    return false;
  });
}

function main() {
  const raw = readStdin();

  if (!raw) {
    console.error("No npm audit JSON input received.");
    process.exit(2);
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    console.error("Failed to parse npm audit JSON input.");
    process.exit(2);
  }

  const vulnerabilities = Object.values(report.vulnerabilities || {});
  const waived = vulnerabilities.filter(isKnownAwsXmlChain);
  const actionable = vulnerabilities.filter((v) => !isKnownAwsXmlChain(v));

  const counts = actionable.reduce(
    (acc, vulnerability) => {
      const severity = vulnerability.severity || "unknown";
      acc[severity] = (acc[severity] || 0) + 1;
      return acc;
    },
    { low: 0, moderate: 0, high: 0, critical: 0, unknown: 0 }
  );

  const total = report.metadata?.vulnerabilities?.total ?? vulnerabilities.length;

  console.log("Security audit policy summary");
  console.log(`- Total vulnerabilities reported: ${total}`);
  console.log(`- Waived (known AWS XML chain highs): ${waived.length}`);
  console.log(
    `- Actionable: critical=${counts.critical}, high=${counts.high}, moderate=${counts.moderate}, low=${counts.low}`
  );

  if (counts.high > 0) {
    console.log("- Warning: Non-waived high vulnerabilities detected.");
  }

  if (counts.critical > 0) {
    console.error("CI policy failed: actionable critical vulnerabilities detected.");
    process.exit(1);
  }

  console.log("CI policy passed: no actionable critical vulnerabilities.");
}

main();
