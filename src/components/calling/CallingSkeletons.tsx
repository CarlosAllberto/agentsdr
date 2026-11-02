import { PageHeaderSkeleton, Skeleton, TableSkeleton } from "@/components/page/Skeletons";

/*
 * The page kit's ListPageSkeleton / DetailPageSkeleton, minus their
 * PageContainer: the calling layout already pads the page, so wrapping again
 * would double the gutters and make the page jump when it loads.
 */

export function CallingListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="mx-auto w-full max-w-[1440px] space-y-6">
      <PageHeaderSkeleton />
      <TableSkeleton rows={4} columns={7} />
    </div>
  );
}

export function CallingDetailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="mx-auto w-full max-w-[1440px] space-y-6">
      <PageHeaderSkeleton back />
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-stroke-soft-200 ring-1 ring-inset ring-stroke-soft-200 lg:grid-flow-col lg:grid-cols-none lg:auto-cols-fr">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 bg-bg-white-0 px-4 py-3">
            <Skeleton className="size-8 rounded-lg" />
            <div className="space-y-1.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-12" />
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-5 border-b border-stroke-soft-200 pb-3">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-14" />
      </div>
      <TableSkeleton rows={5} columns={6} />
    </div>
  );
}
