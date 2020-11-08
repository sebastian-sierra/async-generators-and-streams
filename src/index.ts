import * as fs from "fs"
import { performance } from "perf_hooks"
import * as stream from "stream"
import { Readable } from "stream"
import { promisify } from "util"

import * as Knex from "knex"

const pipeline = promisify(stream.pipeline)

type Line = {
  id: string
  description: string
  quantity: number
}

type Reservation = {
  id: number
  storeId: string
  lines: Line[]
}

async function* groupBy<K, T>(rows: Readable, f: (a: T) => K): AsyncGenerator<T[]> {
  let currentGroupKey = undefined
  let currentGroup: T[] = []
  for await (const row of rows) {
    if (currentGroupKey === undefined) {
      currentGroupKey = f(row)
    } else if (currentGroupKey !== f(row)) {
      yield currentGroup
      currentGroupKey = f(row)
      currentGroup = []
    }
    currentGroup = [...currentGroup, row]
  }
  if (currentGroup.length > 0) {
    yield currentGroup
  }
}

async function* map<T, B>(rows: AsyncGenerator<T>, f: (a: T) => B): AsyncGenerator<B> {
  for await (const row of rows) {
    yield f(row)
  }
}

async function main(): Promise<void> {
  const knex = Knex({
    client: "mysql",
    connection: {
      host: "localhost",
      port: 3306,
      user: "user",
      password: "password",
      database: "knexstreamgroupby",
    },
  })

  const rows = knex
    .select("*")
    .select(knex.ref("RESERVATION.id").as("reservation_id"))
    .select(knex.ref("RESERVATION_LINE.id").as("reservation_line_id"))
    .from("RESERVATION")
    .leftJoin("RESERVATION_LINE", "RESERVATION.id", "RESERVATION_LINE.reservation_id")
    .orderBy("RESERVATION.id")
    .stream()

  const groupedReservations = map(
    map(
      groupBy(rows, (r: any) => r["reservation_id"]),
      (groupedRows: any[]) => {
        const firstRow = groupedRows[0]
        return {
          id: firstRow["reservation_id"],
          storeId: firstRow["store_id"],
          lines:
            firstRow["reservation_line_id"] !== null
              ? groupedRows.map((row) => ({
                  id: row["reservation_line_id"],
                  description: row["description"],
                  quantity: row["quantity"],
                }))
              : [],
        } as Reservation
      }
    ),
    (r: Reservation) => `${JSON.stringify(r)}\n`
  )

  const writable = fs.createWriteStream("./result.jsonl")
  await pipeline(Readable.from(groupedReservations), writable)
}

const startTime = performance.now()
main()
  .then(() => {
    const endTime = performance.now()
    console.log(`Processed all records correctly in ${(endTime - startTime) / 1000} seconds`)
    const used = process.memoryUsage().heapUsed / 1024 / 1024
    console.log(`This script uses approximately ${used} MB`)
    process.exit()
  })
  .catch((error) => {
    console.error("Fatal error while trying to export data", error)
    process.exit(1)
  })
