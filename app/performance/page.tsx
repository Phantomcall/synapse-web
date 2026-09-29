import history from "../../public/performance/history.json";

interface PerformanceRecord {
  date: string;
  commit: string;
  bundleJsBytes: number;
  lighthouseScore: number;
  lcpMs: number;
  cls: number;
  tbtMs: number;
}

const chartStyle = {
  border: "1px solid var(--border)",
  background: "var(--bg1)",
  padding: 16,
  minWidth: 0,
};

function TrendChart({
  title,
  records,
  value,
  color,
  format,
}: {
  title: string;
  records: PerformanceRecord[];
  value: (record: PerformanceRecord) => number;
  color: string;
  format: (value: number) => string;
}) {
  const values = records.map(value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = maximum - minimum || 1;
  const points = values
    .map((item, index) => {
      const x = records.length === 1 ? 50 : (index / (records.length - 1)) * 100;
      const y = 88 - ((item - minimum) / range) * 72;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <section style={chartStyle}>
      <h2 style={{ margin: 0, fontSize: 12, color: "var(--dim)" }}>{title}</h2>
      <svg
        viewBox="0 0 100 100"
        role="img"
        aria-label={`${title} trend over ${records.length} builds`}
        style={{ width: "100%", height: 130, overflow: "visible" }}
      >
        <line x1="0" y1="88" x2="100" y2="88" stroke="var(--border)" />
        {records.length > 1 && (
          <polyline
            points={points}
            fill="none"
            stroke={color}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {values.map((item, index) => {
          const x = records.length === 1 ? 50 : (index / (records.length - 1)) * 100;
          const y = 88 - ((item - minimum) / range) * 72;
          return (
            <circle key={`${records[index].commit}-${index}`} cx={x} cy={y} r="2.5" fill={color} />
          );
        })}
      </svg>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          color: "var(--dim)",
        }}
      >
        <span>{format(values[0])}</span>
        <span>{format(values[values.length - 1])}</span>
      </div>
    </section>
  );
}

export default function PerformancePage() {
  const records = (history as PerformanceRecord[]).slice(-30);
  const latest = records.at(-1);

  return (
    <main
      style={{
        maxWidth: 1080,
        margin: "0 auto",
        padding: "36px 24px",
        color: "#fff",
        fontFamily: "var(--font-ibm-plex-mono), monospace",
      }}
    >
      <a href="/" style={{ color: "var(--status-processing)", fontSize: 12 }}>
        Synapse Core
      </a>
      <header style={{ margin: "24px 0 28px" }}>
        <p style={{ color: "var(--status-pending)", fontSize: 10, margin: "0 0 8px" }}>
          CI PERFORMANCE
        </p>
        <h1 style={{ fontSize: 24, margin: 0 }}>Performance history</h1>
        <p style={{ color: "var(--dim)", fontSize: 12, marginTop: 10 }}>
          {latest
            ? `${records.length} recent main-branch builds · latest ${latest.commit}`
            : "Metrics will appear after the first successful main-branch Lighthouse run."}
        </p>
      </header>

      {records.length > 0 ? (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
              gap: 10,
            }}
          >
            <TrendChart
              title="LIGHTHOUSE SCORE"
              records={records}
              value={(record) => record.lighthouseScore}
              color="var(--status-completed)"
              format={(value) => `${value}/100`}
            />
            <TrendChart
              title="LARGEST CONTENTFUL PAINT"
              records={records}
              value={(record) => record.lcpMs}
              color="var(--status-processing)"
              format={(value) => `${(value / 1000).toFixed(2)} s`}
            />
            <TrendChart
              title="INITIAL ROUTE JAVASCRIPT"
              records={records}
              value={(record) => record.bundleJsBytes}
              color="var(--status-pending)"
              format={(value) => `${(value / 1024).toFixed(0)} KiB`}
            />
          </div>
          <div style={{ overflowX: "auto", marginTop: 24 }}>
            <table
              style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: 11 }}
            >
              <thead>
                <tr>
                  {["DATE", "COMMIT", "SCORE", "LCP", "CLS", "TBT", "JS"].map((heading) => (
                    <th
                      key={heading}
                      style={{
                        padding: "10px 8px",
                        color: "var(--dim)",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...records].reverse().map((record) => (
                  <tr key={record.commit}>
                    <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--border)" }}>
                      {new Date(record.date).toLocaleDateString("en", {
                        month: "short",
                        day: "numeric",
                      })}
                    </td>
                    <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--border)" }}>
                      {record.commit}
                    </td>
                    <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--border)" }}>
                      {record.lighthouseScore}
                    </td>
                    <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--border)" }}>
                      {(record.lcpMs / 1000).toFixed(2)} s
                    </td>
                    <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--border)" }}>
                      {record.cls.toFixed(3)}
                    </td>
                    <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--border)" }}>
                      {record.tbtMs} ms
                    </td>
                    <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--border)" }}>
                      {(record.bundleJsBytes / 1024).toFixed(0)} KiB
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p
          style={{
            borderTop: "1px solid var(--border)",
            paddingTop: 16,
            color: "var(--dim)",
            fontSize: 12,
          }}
        >
          No successful CI performance runs have been recorded yet.
        </p>
      )}
      <p style={{ color: "var(--dim)", fontSize: 10, marginTop: 20 }}>
        LCP and CLS are Lighthouse lab measurements. TBT is shown as an INP lab proxy; field INP
        requires real-user monitoring.
      </p>
    </main>
  );
}
