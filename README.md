# Streams and Async Iterators/Generators

We recently came across this problem in node.js: How could we export a mysql 1 to N relationship in JSONL format knowing
we could have over a million lines that could end up in a `FATAL error - process out of memory` if we tried to treat
them all at once ?

Before looking at our solution lets take a look first to our DB model:

```sql
CREATE TABLE RESERVATION(
  id VARCHAR(255) NOT NULL,
  store_id VARCHAR(255) NOT NULL,
  creation_date DATETIME,
  PRIMARY KEY (id)
);

CREATE TABLE RESERVATION_LINE(
  id VARCHAR(255) NOT NULL,
  reservation_id VARCHAR(255) NOT NULL REFERENCES RESERVATION(id),
  description VARCHAR(255),
  quantity INT(255) NOT NULL,
  PRIMARY KEY (id)
)
```

We have some reservations for our clients and each reservation has N lines, each one specifying a product description
and a quantity. We would like to export a reservation with its lines as this typescript interface to a JSONL file:

```typescript
interface Line {
  id: string
  description: string
  quantity: number
}

interface Reservation {
  id: number
  storeId: string
  lines: Line[]
}
```

The first step would be to query our DB and stream the result. Using a library like
[knex](http://knexjs.org/#Interfaces-stream) our query would look like something like this:

```typescript
const rows = knex
  .select("*")
  .select(knex.ref("RESERVATION.id").as("reservation_id"))
  .select(knex.ref("RESERVATION_LINE.id").as("reservation_line_id"))
  .from("RESERVATION")
  .leftJoin("RESERVATION_LINE", "RESERVATION.id", "RESERVATION_LINE.reservation_id")
  .orderBy("RESERVATION.id")
  .stream()
```

Now the next step is to group all the rows that belong to the same reservation and transform them to our desire schema.
If all the lines could fit to memory we could do something like this:

```typescript
function groupAndTransformRowsToReservations(rows: any[]) {
  let currentReservation: Reservation | undefined = undefined
  let groupedReservations: Reservation[] = []
  for (const row of rows) {
    const rowId = row["reservation_id"]
    if (currentReservation === undefined) {
      currentReservation = {
        id: rowId,
        storeId: row["store_id"],
        lines: [],
      }
    } else if (currentReservation.id !== rowId) {
      groupedReservations = [...groupedReservations, currentReservation]
      currentReservation = {
        id: rowId,
        storeId: row["store_id"],
        lines: [],
      }
    }
    currentReservation = {
      ...currentReservation,
      lines: [
        ...currentReservation.lines,
        {
          id: row["reservation_line_id"],
          description: row["description"],
          quantity: row["quantity"],
        },
      ],
    }
  }
  if (currentReservation !== undefined) {
    groupedReservations = [...groupedReservations, currentReservation]
  }
  return groupedReservations
}
```

Unfortunately this is not our case :( Our first clue would be to use a
[Transform Stream](https://nodejs.org/docs/latest-v12.x/api/stream.html#stream_class_stream_transform) but we would have 
to make a bigrefactor to make our snippet work. We would also have to manipulate streams
in a low level fashion calling the push and callback functions explicitly and
error handling would be our responsibility.

The good news is that Streams play really well with 
[Async Iterators](https://nodejs.org/docs/latest-v12.x/api/stream.html#stream_streams_compatibility_with_async_generators_and_async_iterators).
We can also use classic error handling from Promises with a `try-catch` block, or a catch function.

If you are not familiar with async iterators they are like regular iterators
except the `next()` method returns a `Promise`. So, we can consume a readable
stream with async iterators:

```typescript
async function example(readable) {
  for await (const chunk of readable) {
    console.log(`We're consuming the current chunk: ${chunk}`)
  }
}
```

We can also generate new async values with **Async Generators**. An Async
generator is a function that can produce multiple async values that could be later consumed
with Async generators or by explicitly calling the `next()` method.

```typescript
async function* transformToUppercase(readable) {
  for await (const chunk of readable) {
    yield chunk.toUpperCase()
  }
}
```

Notice the `*` after the `function` keyword which lets implement our function as
a generator and the `yield` keyword that allows us to produce multiple async values.

With both of these concepts in mind we can rewrite our `groupAndTransformRowsToReservations`
to work with our knex `ReadableStream` :

```typescript
async function* groupAndTransformRowsToReservations(rows: Readable) {
  let currentReservation: Reservation | undefined = undefined

  for await (const row of rows) {
    const rowId = row["reservation_id"]
    if (currentReservation === undefined) {
      currentReservation = {
        id: rowId,
        storeId: row["store_id"],
        lines: [],
      }
    } else if (currentReservation.id !== rowId) {
      yield `${JSON.stringify(currentReservation)}\n}`
      currentReservation = {
        id: rowId,
        storeId: row["store_id"],
        lines: [],
      }
    }
    currentReservation = {
      ...currentReservation,
      lines: [
        ...currentReservation.lines,
        {
          id: row["reservation_line_id"],
          description: row["description"],
          quantity: row["quantity"],
        },
      ],
    }
  }
  if (currentReservation !== undefined) {
    yield `${JSON.stringify(currentReservation)}\n}`
  }
}
```

Now we just have to go from our async generator to a readable in order to pipe it to
our file write stream:

```typescript
const groupedReservations = groupAndTransformRowsToReservations(rows)
await pipeline(Readable.from(groupedReservations), fs.createWriteStream("./result.jsonl"))
```

Nice ! We're transforming and writing to disk around 1000000 rows in about 12 seconds without
any memory issues. We can still refactor a little our code because is not reusable at all. Let's write some abstractions
that would allow us to use reuse our functions with other tables.

We can break up our transformations in three steps:

- **Group** all the rows from the same reservation together
- **Map** the array of rows to one single reservation with multiple reservation
  lines
- **Map** our reservation to a json line

Ok, so let's start by writing a generic `groupBy` function that takes as a parameter
an async iterator, a group by key function for each element and returns us an Async generator which produces elements 
each time we have a complete row group:

**BE CAREFUL:** This `groupBy` function only works in iterators that are sort by K

```typescript
async function* groupBy<K, T>(rows: Readable, f: (a: T) => K): AsyncGenerator<T[]> {
  let currentGroupKey = undefined
  let currentGroup: T[] = []
  for await (const row of rows) {
    const rowKey = f(row)
    if (currentGroupKey === undefined) {
      currentGroupKey = rowKey
    } else if (currentGroupKey !== rowKey) {
      yield currentGroup
      currentGroupKey = rowKey
      currentGroup = []
    }
    currentGroup = [...currentGroup, row]
  }
  if (currentGroup.length > 0) {
    yield currentGroup
  }
}
```

Now, let's write a map function that simply transforms each element of an Async iterator individually according to a 
given function f:

```typescript
async function* map<T, B>(rows: AsyncGenerator<T>, f: (a: T) => B): AsyncGenerator<B> {
  for await (const row of rows) {
    yield f(row)
  }
}
```

Finally, we can rewrite our reservations example as follows using our new `groupBy`
and `map` functions:

```typescript
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
      }
    }
  ),
  (r) => `${JSON.stringify(r)}\n`
)
```

Much better ! We can reuse our functions with other tables we might export from
our database !

**Note:** As a friend of me pointed out, we could have done our `group by` in the SQL query directly:

```sql
SELECT R.id,
       JSON_ARRAYAGG(JSON_OBJECT(
         "reservation_id", reservation_id,
         "description", description,
         "quantity", quantity
           )) AS `lines`,
       store_id,
       creation_date
FROM RESERVATION R
         JOIN RESERVATION_LINE RL on R.id = RL.reservation_id
GROUP BY reservation_id
```
This could also perform better that grouping by in our node script, nevertheless the purpose of the article is to give
an example of how to transform streams using async iterators/generators. As a bonus point, our `groupBy` and `map` 
functions also work with different sources. We could consume a csv file or different http requests for example and 
manipulate them with our functions.

## Further reading
* [Async iteration and generators](https://javascript.info/async-iterators-generators#async-generators-finally)
* [Transforming data with Node.js transform streams](http://codewinds.com/blog/2013-08-20-nodejs-transform-streams.html#what_are_transform_streams_)
* [Streams compatibility with async generators and async iterators](https://nodejs.org/api/stream.html#stream_streams_compatibility_with_async_generators_and_async_iterators)
* [Easier Node.js streams via async iteration](https://2ality.com/2019/11/nodejs-streams-async-iteration.html#transforming-readable-streams-via-async-generators)

