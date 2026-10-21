import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoverInterruptedJobs } from '@/lib/engine'

export const dynamic = 'force-dynamic'

export async function GET() {
  await recoverInterruptedJobs()
  const jobs = await db.download.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return NextResponse.json({ jobs })
}
