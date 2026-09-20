import { PageHeader } from "@/app/_components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { readProducts } from "@/lib/data/mock-data";
import { formatDate, formatMoney } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Products() {
  const products = await readProducts();
  const discontinued = products.filter((product) => product.status).length;

  return (
    <>
      <PageHeader
        title="Products"
        description={`${products.length} in the current price list${
          discontinued > 0 ? `, ${discontinued} discontinued` : ""
        }`}
      />

      <div className="p-7">
        <Card>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product ID</TableHead>
                  <TableHead>Brand</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead data-numeric>Dealer price</TableHead>
                  <TableHead data-numeric>MRP</TableHead>
                  <TableHead data-numeric>Margin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((product) => (
                  <TableRow key={product.productId}>
                    <TableCell className="font-mono text-xs">
                      {product.productId}
                    </TableCell>
                    <TableCell>{product.brand}</TableCell>
                    <TableCell className="font-medium">
                      <div className="flex flex-wrap items-center gap-2">
                        {product.model}
                        {product.status ? (
                          <Badge variant="outline" className="font-normal">
                            Discontinued
                            {product.discontinuedOn
                              ? ` ${formatDate(product.discontinuedOn)}`
                              : ""}
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {product.category}
                    </TableCell>
                    <TableCell data-numeric>{formatMoney(product.dealerPrice)}</TableCell>
                    <TableCell data-numeric>{formatMoney(product.mrp)}</TableCell>
                    <TableCell data-numeric className="text-muted-foreground">
                      {Math.round(
                        ((product.mrp - product.dealerPrice) / product.mrp) * 100,
                      )}
                      %
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
