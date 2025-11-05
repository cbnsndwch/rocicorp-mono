# Aggregations in ZQL

ZQL now supports SQL-style aggregation operations with incremental view maintenance. This allows you to efficiently compute grouped statistics that update automatically as your data changes.

## Supported Aggregations

- **COUNT**: Count rows in each group
- **SUM**: Sum numeric values
- **AVG**: Calculate average of numeric values
- **MIN**: Find minimum value (⚠️ see limitations)
- **MAX**: Find maximum value (⚠️ see limitations)

## Basic Usage

### Group By + Count

```typescript
// Count orders per customer
const result = await z.query.orders
  .groupBy('customerId')
  .count('orderCount');

// Result: [{customerId: 'c1', orderCount: 5}, {customerId: 'c2', orderCount: 3}, ...]
```

### Group By + Sum

```typescript
// Calculate total revenue per customer
const result = await z.query.orders
  .groupBy('customerId')
  .sum('amount', 'totalRevenue');

// Result: [{customerId: 'c1', totalRevenue: 1250}, ...]
```

### Multiple Aggregates

```typescript
// Get multiple statistics per group
const result = await z.query.orders
  .groupBy('customerId')
  .count('orderCount')
  .sum('amount', 'totalAmount')
  .sum('quantity', 'totalItems');

// Result: [{customerId: 'c1', orderCount: 5, totalAmount: 1250, totalItems: 42}, ...]
```

### Multiple Group By Fields

```typescript
// Group by multiple columns
const result = await z.query.sales
  .groupBy('region', 'product')
  .sum('revenue', 'totalRevenue');

// Result: [{region: 'US', product: 'Widget', totalRevenue: 50000}, ...]
```

## Global Aggregations (No GROUP BY)

When you don't specify groupBy, aggregates are computed across all rows:

```typescript
// Count all orders
const stats = await z.query.orders
  .count('total');

// Result: [{total: 150}]

// Multiple global aggregates
const summary = await z.query.orders
  .count('orderCount')
  .sum('amount', 'totalRevenue')
  .avg('amount', 'avgOrderValue');

// Result: [{orderCount: 150, totalRevenue: 125000, avgOrderValue: 833.33}]
```

## Having Clause

Filter groups based on aggregate values:

```typescript
// Only customers with more than 5 orders
const bigCustomers = await z.query.orders
  .groupBy('customerId')
  .count('orderCount')
  .having('orderCount', '>', 5);

// Only regions with revenue over $100k
const topRegions = await z.query.sales
  .groupBy('region')
  .sum('revenue', 'totalRevenue')
  .having('totalRevenue', '>', 100000);

// Having with equals (shorthand)
const exactMatch = await z.query.orders
  .groupBy('status')
  .count('total')
  .having('total', 10); // Equivalent to having('total', '=', 10)
```

## Combining with Other Query Operations

Aggregations can be combined with where, orderBy, and limit:

```typescript
// Filter before aggregation, then filter results
const result = await z.query.orders
  .where('status', 'completed')              // Filter rows
  .groupBy('customerId')                      // Group
  .sum('amount', 'totalRevenue')             // Aggregate
  .having('totalRevenue', '>', 1000)         // Filter groups
  .orderBy('totalRevenue', 'desc')           // Sort by aggregate
  .limit(10);                                // Top 10

// With related data
const customerStats = await z.query.users
  .related('orders', q => q
    .groupBy('status')
    .count('statusCount')
  );
```

## Incremental Updates

Aggregations automatically update as your data changes:

```typescript
// Set up a materialized view
const view = z.query.orders
  .groupBy('customerId')
  .sum('amount', 'totalRevenue')
  .materialize();

// Subscribe to changes
view.addListener(() => {
  const results = view.data;
  // Results automatically reflect new orders, updates, and deletions
});

// Add a new order - aggregates update automatically
await z.mutate.orders.insert({
  id: 'new-order',
  customerId: 'c1',
  amount: 500
});
// The totalRevenue for 'c1' is now automatically updated
```

## API Reference

### groupBy(...fields)

Groups query results by one or more columns.

```typescript
.groupBy('field1')
.groupBy('field1', 'field2', 'field3')
```

### sum(field, alias)

Computes the sum of numeric values in the specified field.

```typescript
.sum('amount', 'totalAmount')
```

### count(alias)
### count(field, alias)

Counts rows in each group. When called with one argument, it's COUNT(*). With two arguments, the first is the field name (to count non-null values only).

```typescript
.count('total')              // COUNT(*)
.count('email', 'hasEmail')  // COUNT(email) - counts non-null emails
```

### avg(field, alias)

Calculates the average of numeric values.

```typescript
.avg('amount', 'avgAmount')
```

### min(field, alias)

Finds the minimum value. ⚠️ See limitations below.

```typescript
.min('price', 'lowestPrice')
```

### max(field, alias)

Finds the maximum value. ⚠️ See limitations below.

```typescript
.max('price', 'highestPrice')
```

### having(field, operator, value)
### having(field, value)

Filters groups based on aggregate values.

```typescript
.having('total', '>', 100)
.having('total', 100)  // Shorthand for '='
```

Supported operators: `=`, `!=`, `>`, `<`, `>=`, `<=`, `IS`, `IS NOT`, `LIKE`, `NOT LIKE`, `IN`, `NOT IN`

## Implementation Details

### Incremental View Maintenance

ZQL maintains aggregate results incrementally:

- **Add**: When a row is added, the group's aggregates are updated (+1 count, +value to sum, etc.)
- **Remove**: When a row is removed, the group's aggregates are decremented
- **Edit**: When a row changes groups, it's removed from the old group and added to the new group

This is much more efficient than recomputing aggregates from scratch on every data change.

### Type Safety

Aggregation methods are fully typed based on your schema:

```typescript
// TypeScript knows 'amount' is a number field
.sum('amount', 'total')  // ✓ OK

.sum('name', 'total')    // ✗ Error: 'name' is not a numeric field
```

## Limitations

### MIN and MAX with Incremental Updates

**Important**: MIN and MAX aggregates cannot be maintained correctly during incremental row removal without storing all values for each group. When a row is removed, if it was the minimum or maximum value, the aggregate result becomes stale.

For example:

```typescript
// Setup
const view = z.query.prices
  .groupBy('category')
  .min('price', 'lowestPrice')
  .materialize();

// If the lowest-priced item is deleted, the 'lowestPrice' will not update
// correctly unless the system re-scans all remaining rows in that category.
```

**Recommendation**: Use MIN/MAX aggregates primarily for:
- Read-only or append-only data
- Scenarios where you can rebuild the view periodically
- Cases where approximate values are acceptable

For production use with frequent updates, consider:
1. Storing all values and recomputing MIN/MAX (memory intensive)
2. Periodic refresh from source data
3. Using a different data structure (e.g., heap) for efficient MIN/MAX tracking

### COUNT with Non-Null Fields

Currently, `count(field, alias)` counts all rows regardless of null values. To properly implement COUNT(field) that excludes nulls, the aggregate operator would need to check null values before incrementing the count.

## Performance Considerations

1. **Group Cardinality**: Performance is best when the number of distinct groups is relatively small. Millions of groups may require more memory.

2. **Aggregate Complexity**: 
   - COUNT and SUM: O(1) per update
   - AVG: O(1) per update (derived from sum/count)
   - MIN/MAX: Cannot be maintained incrementally (see limitations)

3. **Having Filters**: Applied after aggregation, so they don't reduce the number of groups that need to be maintained, only the number returned.

## Examples

### Dashboard Statistics

```typescript
// Real-time dashboard with auto-updating stats
const stats = z.query.analytics
  .where('timestamp', '>', lastWeek)
  .groupBy('eventType')
  .count('eventCount')
  .orderBy('eventCount', 'desc')
  .materialize();
```

### Customer Segments

```typescript
// Find high-value customers
const vipCustomers = await z.query.orders
  .groupBy('customerId')
  .sum('amount', 'lifetime_value')
  .count('order_count')
  .having('lifetime_value', '>', 10000)
  .orderBy('lifetime_value', 'desc');
```

### Time-Series Aggregation

```typescript
// Daily sales totals
const dailySales = await z.query.transactions
  .groupBy('date')
  .sum('amount', 'total')
  .count('transaction_count')
  .orderBy('date', 'desc')
  .limit(30);
```
