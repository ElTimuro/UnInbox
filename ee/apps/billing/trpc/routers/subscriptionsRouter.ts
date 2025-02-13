import { z } from 'zod';
import { parse, stringify } from 'superjson';
import { router, protectedProcedure } from '../trpc';
import { useStripe } from '../../utils/useStripe';
import { stripeBillingPeriods, stripePlanNames } from '../../types';
import { and, eq, sql } from '@uninbox/database/orm';
import {
  lifetimeLicenses,
  orgBilling,
  orgMembers,
  users
} from '@uninbox/database/schema';
// import {
//   postalServers,
//   orgPostalConfigs,
//   domains
// } from '@uninbox/database/schema';
// import { nanoId, nanoIdLength } from '@uninbox/utils';

export const subscriptionsRouter = router({
  updateOrgUserCount: protectedProcedure
    .input(
      z.object({
        orgId: z.number().min(1)
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { stripe, db } = ctx;
      const { orgId } = input;

      const orgSubscriptionQuery = await db.read.query.orgBilling.findFirst({
        where: eq(orgBilling.orgId, orgId),
        columns: {
          id: true,
          orgId: true,
          stripeSubscriptionId: true,
          stripeCustomerId: true,
          plan: true,
          period: true
        }
      });
      if (!orgSubscriptionQuery?.id) {
        throw new Error('Org is not subscribed to a plan');
      }

      const activeOrgMembersCount = await db.read
        .select({ count: sql<number>`count(*)` })
        .from(orgMembers)
        .where(
          and(eq(orgMembers.orgId, orgId), eq(orgMembers.status, 'active'))
        );

      const lifetimeLicensesAssignedToOrg = await db.read
        .select({
          count: sql<number>`count(*)`
        })
        .from(lifetimeLicenses)
        .where(eq(lifetimeLicenses.orgBillingId, orgSubscriptionQuery.id));

      const totalOrgUsers = activeOrgMembersCount[0].count;
      const lifetimeUsers = lifetimeLicensesAssignedToOrg[0].count;
      let chargeableUsers = totalOrgUsers - lifetimeUsers;
      chargeableUsers < 0 && (chargeableUsers = 0);

      const subscriptionDescription =
        lifetimeUsers > 0
          ? `Total users: ${totalOrgUsers} (${chargeableUsers} paid + ${lifetimeUsers} lifetime)`
          : `Total users: ${totalOrgUsers}`;

      const stripeGetSubscriptionResult =
        await useStripe().sdk.subscriptions.retrieve(
          orgSubscriptionQuery.stripeSubscriptionId
        );

      await useStripe().sdk.subscriptions.update(
        orgSubscriptionQuery.stripeSubscriptionId,
        {
          description: subscriptionDescription,
          items: [
            {
              id: stripeGetSubscriptionResult.items.data[0].id,
              quantity: chargeableUsers
            }
          ],
          proration_behavior: 'always_invoice',
          metadata: {
            orgId,
            product: 'subscription',
            plan: stripeGetSubscriptionResult.metadata.plan,
            period: stripeGetSubscriptionResult.metadata.period,
            totalUsers: totalOrgUsers,
            chargeableUsers: chargeableUsers
          }
        }
      );

      return {
        updated: true
      };
    })
});
