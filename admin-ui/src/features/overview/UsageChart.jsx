import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export default function UsageChart({ rollups = [], t }) {
  if (!rollups.length) return null;
  return <section className="panel" aria-label={t("runtime.analytics")}>
    <h2>{t("runtime.analytics")}</h2>
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={rollups}>
        <XAxis dataKey="bucketStart" tickFormatter={value => value?.slice(5, 16)} />
        <YAxis /><Tooltip />
        <Line type="monotone" dataKey="requests" name={t("summary.requests")} stroke="var(--primary)" dot={false} connectNulls={false} />
        <Line type="monotone" dataKey="errors" name={t("summary.errors")} stroke="var(--destructive)" dot={false} connectNulls={false} />
      </LineChart>
    </ResponsiveContainer>
  </section>;
}
