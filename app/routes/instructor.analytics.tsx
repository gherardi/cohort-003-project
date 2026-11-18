import { Link, useSearchParams } from "react-router";
import type { Route } from "./+types/instructor.analytics";
import { getCurrentUserId } from "~/lib/session";
import { getUserById, getUsersByRole } from "~/services/userService";
import { CourseStatus, UserRole } from "~/db/schema";
import {
  getInstructorAnalytics,
  resolveAnalyticsScope,
  type AnalyticsCourseRow,
  type AnalyticsSeriesPoint,
  type AnalyticsSummary,
} from "~/services/analyticsService";
import {
  ANALYTICS_GRANULARITIES,
  ANALYTICS_PERIODS,
  getPeriodOption,
  isGranularityAllowed,
  parseAnalyticsPeriod,
  type AnalyticsGranularity,
  type AnalyticsPeriod,
} from "~/lib/analyticsPeriods";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "~/components/ui/chart";
import { Skeleton } from "~/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { AlertTriangle, BarChart3, GraduationCap, Plus } from "lucide-react";
import { data, isRouteErrorResponse } from "react-router";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { formatPrice } from "~/lib/utils";
import { StarRatingDisplay } from "~/components/star-rating";

export function meta() {
  return [
    { title: "Analytics — Cadence" },
    {
      name: "description",
      content: "Revenue, Enrollments and ratings across your courses",
    },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to view analytics.", {
      status: 401,
    });
  }

  const user = getUserById(currentUserId);

  if (!user) {
    throw data("Only instructors and admins can access this page.", {
      status: 403,
    });
  }

  const url = new URL(request.url);
  const period = parseAnalyticsPeriod(url.searchParams.get("period"));
  const requestedInstructorId = Number(url.searchParams.get("instructorId"));
  const scope = resolveAnalyticsScope(
    user,
    Number.isInteger(requestedInstructorId) && requestedInstructorId > 0
      ? requestedInstructorId
      : null
  );

  if (scope.kind === "forbidden") {
    throw data("Only instructors and admins can access this page.", {
      status: 403,
    });
  }

  // Only admins get the instructor picker
  const instructorPicker =
    user.role === UserRole.Admin
      ? {
          instructors: getUsersByRole(UserRole.Instructor).map((instructor) => ({
            id: instructor.id,
            name: instructor.name,
          })),
          selectedInstructorId:
            scope.kind === "instructor" ? scope.instructorId : null,
        }
      : null;

  if (scope.kind === "none-selected") {
    return { scope: "none-selected" as const, period, instructorPicker };
  }

  return {
    scope: "instructor" as const,
    period,
    instructorPicker,
    analytics: getInstructorAnalytics(
      scope.instructorId,
      period,
      url.searchParams.get("granularity"),
      new Date()
    ),
  };
}

function formatRevenue(cents: number) {
  // formatPrice shows 0 as "Free", which reads wrong for Revenue
  return cents === 0 ? "$0.00" : formatPrice(cents);
}

function statusBadge(status: CourseStatus) {
  switch (status) {
    case CourseStatus.Published:
      return (
        <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400">
          Published
        </span>
      );
    case CourseStatus.Draft:
      return (
        <span className="inline-flex items-center rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400">
          Draft
        </span>
      );
    case CourseStatus.Archived:
      return (
        <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800 dark:bg-gray-900/30 dark:text-gray-400">
          Archived
        </span>
      );
    default:
      return null;
  }
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <div className="mb-8">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="mt-2 h-5 w-72" />
      </div>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-9 w-32" />
              <Skeleton className="mt-2 h-4 w-40" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function InstructorAnalytics({
  loaderData,
}: Route.ComponentProps) {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      {/* Breadcrumb */}
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Analytics</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Analytics</h1>
        <p className="mt-1 text-muted-foreground">
          Revenue, Enrollments and ratings across your courses
        </p>
      </div>

      {loaderData.instructorPicker && (
        <InstructorPicker {...loaderData.instructorPicker} />
      )}

      {loaderData.scope === "none-selected" ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <BarChart3 className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">Select an instructor</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose an instructor to see their analytics.
          </p>
        </div>
      ) : !loaderData.analytics.hasCourses ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <GraduationCap className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">
            You haven't created any courses yet
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a course to start tracking Revenue.
          </p>
          <Link to="/instructor/new" className="mt-4">
            <Button>
              <Plus className="mr-2 size-4" />
              Create Course
            </Button>
          </Link>
        </div>
      ) : (
        <>
          <PeriodTabs period={loaderData.period} />
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <RevenueCard
              summary={loaderData.analytics.summary}
              period={loaderData.period}
            />
            <EnrollmentsCard
              summary={loaderData.analytics.summary}
              period={loaderData.period}
            />
            <RatingCard summary={loaderData.analytics.summary} />
          </div>
          <RevenueChart
            series={loaderData.analytics.series}
            period={loaderData.period}
            granularity={loaderData.analytics.granularity}
          />
          <CoursesTable courses={loaderData.analytics.courses} />
        </>
      )}
    </div>
  );
}

function InstructorPicker({
  instructors,
  selectedInstructorId,
}: {
  instructors: { id: number; name: string }[];
  selectedInstructorId: number | null;
}) {
  const [searchParams, setSearchParams] = useSearchParams();

  function handleChange(value: string) {
    const next = new URLSearchParams(searchParams);
    next.set("instructorId", value);
    setSearchParams(next);
  }

  return (
    <div className="mb-8">
      <Select
        value={selectedInstructorId === null ? "" : String(selectedInstructorId)}
        onValueChange={handleChange}
      >
        <SelectTrigger className="w-64" aria-label="Instructor">
          <SelectValue placeholder="Select an instructor" />
        </SelectTrigger>
        <SelectContent>
          {instructors.map((instructor) => (
            <SelectItem key={instructor.id} value={String(instructor.id)}>
              {instructor.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function PeriodTabs({ period }: { period: AnalyticsPeriod }) {
  const [searchParams, setSearchParams] = useSearchParams();

  function handleChange(value: string) {
    // Keep instructorId (and any other params) while switching period
    const next = new URLSearchParams(searchParams);
    next.set("period", value);
    // Let the new period pick its own default granularity
    next.delete("granularity");
    setSearchParams(next);
  }

  return (
    <Tabs value={period} onValueChange={handleChange} className="mb-6">
      <TabsList aria-label="Period">
        {ANALYTICS_PERIODS.map((option) => (
          <TabsTrigger key={option.value} value={option.value}>
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

function GranularityTabs({
  period,
  granularity,
}: {
  period: AnalyticsPeriod;
  granularity: AnalyticsGranularity;
}) {
  const [searchParams, setSearchParams] = useSearchParams();

  function handleChange(value: string) {
    // Keep period and instructorId while switching granularity
    const next = new URLSearchParams(searchParams);
    next.set("granularity", value);
    setSearchParams(next);
  }

  return (
    <Tabs value={granularity} onValueChange={handleChange}>
      <TabsList aria-label="Granularity">
        {ANALYTICS_GRANULARITIES.map((option) => (
          <TabsTrigger
            key={option.value}
            value={option.value}
            disabled={!isGranularityAllowed(period, option.value)}
          >
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

const revenueChartConfig = {
  revenue: { label: "Revenue", color: "var(--chart-1)" },
} satisfies ChartConfig;

function RevenueChart({
  series,
  period,
  granularity,
}: {
  series: AnalyticsSeriesPoint[];
  period: AnalyticsPeriod;
  granularity: AnalyticsGranularity;
}) {
  return (
    <Card className="mt-6">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1.5">
          <CardTitle>Revenue over time</CardTitle>
          <CardDescription>{getPeriodOption(period).label}</CardDescription>
        </div>
        <GranularityTabs period={period} granularity={granularity} />
      </CardHeader>
      <CardContent>
        {series.length === 0 ? (
          // Only "all time" with no Purchases has no buckets at all; still draw
          // the flat line so "nothing sold" doesn't look like a broken chart
          <ChartContainer config={revenueChartConfig} className="h-64 w-full">
            <LineChart data={[]} margin={{ left: 12, right: 12 }}>
              <CartesianGrid vertical={false} />
              <XAxis type="number" domain={[0, 1]} hide />
              <YAxis
                domain={[0, 1]}
                ticks={[0]}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={64}
                tickFormatter={(cents: number) => formatRevenue(cents)}
              />
              <ReferenceLine
                y={0}
                stroke="var(--color-revenue)"
                strokeWidth={2}
                label={{
                  value: "No Purchases yet",
                  position: "insideBottom",
                  dy: -12,
                  className: "fill-muted-foreground text-sm",
                }}
              />
            </LineChart>
          </ChartContainer>
        ) : (
          <ChartContainer config={revenueChartConfig} className="h-64 w-full">
            <LineChart data={series} margin={{ left: 12, right: 12 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={64}
                allowDecimals={false}
                tickFormatter={(cents: number) => formatRevenue(cents)}
              />
              <ChartTooltip
                cursor={false}
                content={({ active, payload }) => {
                  const point = payload?.[0]?.payload as
                    | AnalyticsSeriesPoint
                    | undefined;
                  if (!active || !point) return null;
                  return <RevenueTooltip point={point} />;
                }}
              />
              <Line
                dataKey="revenue"
                type="monotone"
                stroke="var(--color-revenue)"
                strokeWidth={2}
                dot={series.length <= 31}
              />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function RevenueTooltip({ point }: { point: AnalyticsSeriesPoint }) {
  return (
    <div className="grid min-w-32 gap-1 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{point.label}</div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">Revenue</span>
        <span className="font-mono font-medium tabular-nums">
          {formatRevenue(point.revenue)}
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">Purchases</span>
        <span className="font-mono font-medium tabular-nums">
          {point.purchases}
        </span>
      </div>
    </div>
  );
}

function StatCard({
  title,
  description,
  value,
  caption,
}: {
  title: string;
  description: string;
  value: string;
  caption: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold">{value}</div>
        <p className="mt-1 text-sm text-muted-foreground">{caption}</p>
      </CardContent>
    </Card>
  );
}

function RevenueCard({
  summary,
  period,
}: {
  summary: AnalyticsSummary;
  period: AnalyticsPeriod;
}) {
  return (
    <StatCard
      title="Revenue"
      description={getPeriodOption(period).label}
      value={formatRevenue(summary.revenue)}
      caption={`${summary.purchases} ${summary.purchases === 1 ? "Purchase" : "Purchases"} · ${summary.seats} ${summary.seats === 1 ? "Seat" : "Seats"}`}
    />
  );
}

function EnrollmentsCard({
  summary,
  period,
}: {
  summary: AnalyticsSummary;
  period: AnalyticsPeriod;
}) {
  return (
    <StatCard
      title="Enrollments"
      description={getPeriodOption(period).label}
      value={String(summary.enrollments)}
      caption="Including coupon redemptions and free signups"
    />
  );
}

function RatingCard({ summary }: { summary: AnalyticsSummary }) {
  const { average, count } = summary.rating;

  return (
    <StatCard
      title="Rating"
      description="All time"
      value={average === null ? "—" : average.toFixed(1)}
      caption={`${count} ${count === 1 ? "rating" : "ratings"}`}
    />
  );
}

function CoursesTable({ courses }: { courses: AnalyticsCourseRow[] }) {
  const headerClass =
    "px-4 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground";

  return (
    <Card className="mt-6">
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className={`${headerClass} text-left`}>Course</th>
                <th className={`${headerClass} text-left`}>Status</th>
                <th className={`${headerClass} text-right`}>Revenue</th>
                <th className={`${headerClass} text-right`}>Purchases</th>
                <th className={`${headerClass} text-right`}>Seats</th>
                <th className={`${headerClass} text-right`}>Enrollments</th>
                <th className={`${headerClass} text-left`}>Rating (all time)</th>
              </tr>
            </thead>
            <tbody>
              {courses.map((course) => (
                <tr
                  key={course.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-4 py-3 font-medium">
                    <Link
                      to={`/instructor/${course.id}`}
                      className="hover:underline"
                    >
                      {course.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{statusBadge(course.status)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatRevenue(course.revenue)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {course.purchases}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {course.seats}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {course.enrollments}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {/* Shows "No ratings yet" rather than zero stars */}
                    <StarRatingDisplay
                      average={course.rating.average}
                      count={course.rating.count}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading analytics.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message = typeof error.data === "string" ? error.data : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message = typeof error.data === "string" ? error.data : "You don't have permission to access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/courses">
            <Button variant="outline">Browse Courses</Button>
          </Link>
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
