import { Link, useSearchParams } from "react-router";
import type { Route } from "./+types/instructor.analytics";
import { getCurrentUserId } from "~/lib/session";
import { getUserById, getUsersByRole } from "~/services/userService";
import { UserRole } from "~/db/schema";
import {
  ANALYTICS_PERIODS,
  getInstructorAnalytics,
  parseAnalyticsPeriod,
  resolveAnalyticsScope,
  type AnalyticsPeriod,
  type AnalyticsSummary,
} from "~/services/analyticsService";
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
import { Skeleton } from "~/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { AlertTriangle, BarChart3, GraduationCap, Plus } from "lucide-react";
import { data, isRouteErrorResponse } from "react-router";
import { formatPrice } from "~/lib/utils";

export function meta() {
  return [
    { title: "Analytics — Cadence" },
    { name: "description", content: "Revenue across your courses" },
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
      // Granularity only shapes the chart; use each period's default for now
      getPeriodOption(period).defaultGranularity,
      new Date()
    ),
  };
}

function getPeriodOption(period: AnalyticsPeriod) {
  return ANALYTICS_PERIODS.find((option) => option.value === period)!;
}

function formatRevenue(cents: number) {
  // formatPrice shows 0 as "Free", which reads wrong for Revenue
  return cents === 0 ? "$0.00" : formatPrice(cents);
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <div className="mb-8">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="mt-2 h-5 w-72" />
      </div>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-24" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-9 w-32" />
            <Skeleton className="mt-2 h-4 w-40" />
          </CardContent>
        </Card>
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
          Revenue across your courses
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
          </div>
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

function RevenueCard({
  summary,
  period,
}: {
  summary: AnalyticsSummary;
  period: AnalyticsPeriod;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue</CardTitle>
        <CardDescription>{getPeriodOption(period).label}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold">
          {formatRevenue(summary.revenue)}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {summary.purchases} {summary.purchases === 1 ? "Purchase" : "Purchases"}
          {" · "}
          {summary.seats} {summary.seats === 1 ? "Seat" : "Seats"}
        </p>
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
