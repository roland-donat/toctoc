import { formatCount, formatRate, type DimensionRow } from "@/lib/stats-api"

interface StatsTableProps {
  rows: readonly DimensionRow[]
  /** Turnout per round, or profile of voters and abstainers. */
  mode: "participation" | "profil"
  caption: string
}

const TH = "px-2 py-1.5 text-right font-medium"
const TD = "px-2 py-1.5 text-right tabular-nums"

/** Table view of a dimension: every "< 5" cell is rendered as is. */
export function StatsTable({ rows, mode, caption }: StatsTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b text-xs text-muted-foreground">
          {mode === "participation" ? (
            <tr>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                Groupe
              </th>
              <th scope="col" className={TH}>
                Inscrits T1
              </th>
              <th scope="col" className={TH}>
                Votants T1
              </th>
              <th scope="col" className={TH}>
                Taux T1
              </th>
              <th scope="col" className={TH}>
                Inscrits T2
              </th>
              <th scope="col" className={TH}>
                Votants T2
              </th>
              <th scope="col" className={TH}>
                Taux T2
              </th>
            </tr>
          ) : (
            <tr>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                Groupe
              </th>
              <th scope="col" className={TH}>
                Votants
              </th>
              <th scope="col" className={TH}>
                Part des votants
              </th>
              <th scope="col" className={TH}>
                Abstentionnistes
              </th>
              <th scope="col" className={TH}>
                Part des abstentionnistes
              </th>
            </tr>
          )}
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b last:border-b-0">
              <th scope="row" className="px-2 py-1.5 text-left font-normal">
                {r.label}
              </th>
              {mode === "participation" ? (
                <>
                  <td className={TD}>{formatCount(r.t1.eligible)}</td>
                  <td className={TD}>{formatCount(r.t1.voters)}</td>
                  <td className={TD}>{formatRate(r.t1.rate)}</td>
                  <td className={TD}>{formatCount(r.t2.eligible)}</td>
                  <td className={TD}>{formatCount(r.t2.voters)}</td>
                  <td className={TD}>{formatRate(r.t2.rate)}</td>
                </>
              ) : (
                <>
                  <td className={TD}>{formatCount(r.profile.voters.count)}</td>
                  <td className={TD}>{formatRate(r.profile.voters.share)}</td>
                  <td className={TD}>{formatCount(r.profile.abstainers.count)}</td>
                  <td className={TD}>{formatRate(r.profile.abstainers.share)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
