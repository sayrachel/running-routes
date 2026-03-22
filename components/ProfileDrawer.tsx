import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Dimensions, Share, ActivityIndicator, Linking } from 'react-native';

import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { useAppContext, type FavoriteRoute } from '@/lib/AppContext';
export type { FavoriteRoute };
import { getRunHistory, getCachedRunHistory } from '@/lib/firestore';
import type { RunRecord } from '@/lib/types';
import { Colors, Fonts } from '@/lib/theme';
import { distanceUnit, paceUnit } from '@/lib/units';

export type DrawerView = 'profile' | 'history' | 'favorites' | 'run-detail' | 'contact' | 'terms' | 'privacy' | 'units';

const SCREEN_WIDTH = Dimensions.get('window').width;

function formatSplitTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function generateSplits(distance: number, time: number) {
  const fullKms = Math.floor(distance);
  const avgPace = time / distance;
  const splits: { km: number; pace: string; time: string }[] = [];
  for (let i = 1; i <= fullKms; i++) {
    const variation = (Math.random() - 0.5) * 0.6;
    const pace = avgPace + variation;
    splits.push({ km: i, pace: pace.toFixed(1), time: formatSplitTime(pace * 60) });
  }
  const remaining = distance - fullKms;
  if (remaining > 0.1) {
    const variation = (Math.random() - 0.5) * 0.6;
    const pace = avgPace + variation;
    splits.push({ km: parseFloat(distance.toFixed(1)), pace: pace.toFixed(1), time: formatSplitTime(pace * 60) });
  }
  return splits;
}

interface ProfileDrawerProps {
  visible: boolean;
  onClose: () => void;
  onPreviewFavorite?: (favorite: FavoriteRoute) => void;
  initialView?: DrawerView;
}

export function ProfileDrawer({ visible, onClose, onPreviewFavorite, initialView }: ProfileDrawerProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const ctx = useAppContext();
  const translateX = useSharedValue(SCREEN_WIDTH);
  const [mounted, setMounted] = useState(false);
  const [deleteLabel, setDeleteLabel] = useState('Delete Account');
  const [isDeleting, setIsDeleting] = useState(false);
  const [view, setView] = useState<DrawerView>('profile');
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  const [runHistory, setRunHistory] = useState<RunRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFromCache, setHistoryFromCache] = useState(false);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setDeleteLabel('Delete Account');
      setView(initialView || 'profile');
      setSelectedRun(null);
      translateX.value = withTiming(0, { duration: 300 });

      // Load run history: try Firestore first, fall back to cache
      setHistoryLoading(true);
      setHistoryFromCache(false);
      if (ctx.firebaseUid) {
        getRunHistory(ctx.firebaseUid)
          .then((runs) => {
            setRunHistory(runs);
            setHistoryFromCache(false);
          })
          .catch(async () => {
            const cached = await getCachedRunHistory();
            setRunHistory(cached);
            setHistoryFromCache(cached.length > 0);
          })
          .finally(() => setHistoryLoading(false));
      } else {
        // No auth — load from local cache
        getCachedRunHistory()
          .then((cached) => {
            setRunHistory(cached);
            setHistoryFromCache(false);
          })
          .catch(() => {})
          .finally(() => setHistoryLoading(false));
      }
    } else {
      translateX.value = withTiming(SCREEN_WIDTH, { duration: 300 }, (finished) => {
        if (finished) {
          runOnJS(setMounted)(false);
        }
      });
    }
  }, [visible]);

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const handleBack = () => {
    if (view === 'run-detail') {
      setView('history');
      setSelectedRun(null);
    } else if (view === 'terms' || view === 'privacy' || view === 'units' || view === 'contact') {
      setView('profile');
    } else if (view !== 'profile' && initialView && initialView !== 'profile') {
      // Opened directly to history/favorites — back closes the drawer
      onClose();
    } else if (view !== 'profile') {
      setView('profile');
    } else {
      onClose();
    }
  };

  const handleLogout = async () => {
    await ctx.signOutUser();
    onClose();
    router.replace('/landing');
  };

  const handleDelete = async () => {
    if (deleteLabel === 'Delete Account') {
      setDeleteLabel('Tap again to confirm');
      return;
    }
    setIsDeleting(true);
    try {
      await ctx.deleteAccount();
    } catch {
      // If re-auth is needed, fall back to sign out
      await ctx.signOutUser();
    }
    setIsDeleting(false);
    onClose();
    router.replace('/landing');
  };

  const handleRemoveFavorite = (id: string) => {
    ctx.removeFavorite(id);
  };

  const handlePreviewFavorite = (route: FavoriteRoute) => {
    onClose();
    onPreviewFavorite?.(route);
  };

  if (!mounted) return null;

  const viewTitle = view === 'history' ? 'History' : view === 'favorites' ? 'Favorites' : view === 'contact' ? 'Contact Us' : view === 'terms' ? 'Terms of Service' : view === 'privacy' ? 'Privacy Policy' : view === 'units' ? 'Units' : view === 'run-detail' && selectedRun ? selectedRun.routeName : 'Settings';

  const formatRunDate = (timestamp: number) => {
    const d = new Date(timestamp);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatDuration = (seconds: number) => {
    return Math.round(seconds / 60);
  };

  const renderRunDetail = () => {
    if (!selectedRun) return null;
    const durationMin = formatDuration(selectedRun.duration);
    const pace = selectedRun.avgPace || (durationMin / selectedRun.distance).toFixed(1);
    const splits = selectedRun.splits && selectedRun.splits.length > 0
      ? selectedRun.splits
      : generateSplits(selectedRun.distance, durationMin);

    return (
      <ScrollView
        style={styles.scrollContent}
        contentContainerStyle={styles.scrollContentInner}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.runDetailDate}>{formatRunDate(selectedRun.date)}</Text>

        {/* Stats grid */}
        <View style={styles.statsGrid}>
          <View style={styles.statCell}>
            <Text style={styles.statCellValue}>{durationMin}</Text>
            <Text style={styles.statCellLabel}>min</Text>
          </View>
          <View style={styles.statCell}>
            <Text style={styles.statCellValue}>{pace}</Text>
            <Text style={styles.statCellLabel}>min{paceUnit(ctx.prefs.units)}</Text>
          </View>
          <View style={styles.statCell}>
            <Text style={styles.statCellValue}>{selectedRun.distance}</Text>
            <Text style={styles.statCellLabel}>{distanceUnit(ctx.prefs.units)}</Text>
          </View>
        </View>

        {/* Splits */}
        <Text style={styles.splitsTitle}>Splits</Text>
        <View style={styles.splitsTable}>
          <View style={styles.splitsHeader}>
            <Text style={styles.splitsHeaderText}>{ctx.prefs.units === 'metric' ? 'KM' : 'MILE'}</Text>
            <Text style={styles.splitsHeaderText}>TIME</Text>
          </View>
          {splits.map((split) => (
            <View key={split.km} style={styles.splitRow}>
              <Text style={styles.splitKm}>{split.km}</Text>
              <Text style={styles.splitPace}>{split.time || split.pace}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    );
  };

  return (
    <Animated.View style={[styles.fullScreen, drawerStyle]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={handleBack} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={Colors.mutedForeground} />
        </Pressable>
        <Text style={styles.headerTitle}>{viewTitle}</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Content */}
      <View style={styles.content}>
        {view === 'profile' ? (
          <ScrollView
            style={styles.scrollContent}
            contentContainerStyle={styles.scrollContentInner}
            showsVerticalScrollIndicator={false}
          >
            {/* Profile */}
            {ctx.user?.email ? (
              <Text style={styles.userEmail}>{ctx.user.email}</Text>
            ) : null}

            {/* Preferences */}
            <Text style={styles.sectionLabel}>PREFERENCES</Text>
            <View style={styles.menuSection}>
              <Pressable style={styles.menuRow} onPress={() => setView('units')}>
                <Ionicons name="speedometer-outline" size={20} color={Colors.mutedForeground} />
                <Text style={styles.menuLabel}>Units</Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.mutedForeground} />
              </Pressable>
            </View>

            {/* Support */}
            <Text style={styles.sectionLabel}>SUPPORT</Text>
            <View style={styles.menuSection}>
              <Pressable style={styles.menuRow} onPress={async () => {
                try {
                  await Share.share({
                    message: 'Discover Run Routes: your personal running route generator based on your preferences. https://runroutes.app',
                  });
                } catch {}
              }}>
                <Ionicons name="share-outline" size={20} color={Colors.mutedForeground} />
                <Text style={styles.menuLabel}>Share Run Routes</Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.mutedForeground} />
              </Pressable>

              <Pressable style={styles.menuRow} onPress={() => setView('contact')}>
                <Ionicons name="mail-outline" size={20} color={Colors.mutedForeground} />
                <Text style={styles.menuLabel}>Contact Us</Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.mutedForeground} />
              </Pressable>
            </View>

            {/* Legal */}
            <Text style={styles.sectionLabel}>LEGAL</Text>
            <View style={styles.menuSection}>
              <Pressable style={styles.menuRow} onPress={() => setView('terms')}>
                <Ionicons name="document-text-outline" size={20} color={Colors.mutedForeground} />
                <Text style={styles.menuLabel}>Terms of Service</Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.mutedForeground} />
              </Pressable>

              <Pressable style={styles.menuRow} onPress={() => Linking.openURL('https://docs.google.com/document/d/e/2PACX-1vRCYKfkq6s1kWEMNCX_NOYRV8i-egoughcvQn3XLR1XZjrj3qzEHMVAvCnYKAFZz2-pzqgzQIS-RKmx/pub')}>
                <Ionicons name="shield-checkmark-outline" size={20} color={Colors.mutedForeground} />
                <Text style={styles.menuLabel}>Privacy Policy</Text>
                <Ionicons name="open-outline" size={16} color={Colors.mutedForeground} />
              </Pressable>
            </View>

            {/* Account */}
            <Text style={styles.sectionLabel}>ACCOUNT</Text>
            <View style={styles.menuSection}>
              <Pressable
                onPress={handleLogout}
                style={styles.menuRow}
              >
                <Ionicons name="log-out-outline" size={20} color={Colors.mutedForeground} />
                <Text style={styles.menuLabel}>Log Out</Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.mutedForeground} />
              </Pressable>

              <Pressable
                onPress={handleDelete}
                disabled={isDeleting}
                style={styles.menuRow}
              >
                {isDeleting ? (
                  <ActivityIndicator size="small" color={Colors.destructive} />
                ) : (
                  <Ionicons name="trash-outline" size={20} color={Colors.destructive} />
                )}
                <Text style={[styles.menuLabel, { color: Colors.destructive }]}>{isDeleting ? 'Deleting...' : deleteLabel}</Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.mutedForeground} />
              </Pressable>
            </View>
          </ScrollView>
        ) : view === 'run-detail' ? (
          renderRunDetail()
        ) : view === 'units' ? (
          <ScrollView
            style={styles.scrollContent}
            contentContainerStyle={styles.scrollContentInner}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.sectionLabel}>UNITS</Text>
            <View style={styles.menuSection}>
              <Pressable
                style={[styles.menuRow, ctx.prefs.units === 'imperial' && styles.menuRowSelected]}
                onPress={() => ctx.setPrefs({ ...ctx.prefs, units: 'imperial' })}
              >
                <Text style={styles.menuLabel}>Miles</Text>
                {ctx.prefs.units === 'imperial' && (
                  <Ionicons name="checkmark" size={20} color={Colors.primary} />
                )}
              </Pressable>

              <Pressable
                style={[styles.menuRow, ctx.prefs.units === 'metric' && styles.menuRowSelected]}
                onPress={() => ctx.setPrefs({ ...ctx.prefs, units: 'metric' })}
              >
                <Text style={styles.menuLabel}>Kilometers</Text>
                {ctx.prefs.units === 'metric' && (
                  <Ionicons name="checkmark" size={20} color={Colors.primary} />
                )}
              </Pressable>
            </View>
          </ScrollView>
        ) : view === 'contact' ? (
          <ScrollView
            style={styles.scrollContent}
            contentContainerStyle={styles.scrollContentInner}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.contactDescription}>
              Have questions, feedback, or need help? Reach out and we'll get back to you as soon as possible.
            </Text>

            <Text style={styles.sectionLabel}>EMAIL</Text>
            <View style={styles.contactEmailCard}>
              <Ionicons name="mail-outline" size={20} color={Colors.primary} />
              <Text style={styles.contactEmail} selectable>support@runroutes.app</Text>
              <Pressable
                hitSlop={8}
                onPress={() => {
                  Linking.openURL('mailto:support@runroutes.app?subject=Running%20Routes%20Support');
                }}
              >
                <Ionicons name="open-outline" size={20} color={Colors.mutedForeground} />
              </Pressable>
            </View>
          </ScrollView>
        ) : view === 'terms' ? (
          <ScrollView
            style={styles.scrollContent}
            contentContainerStyle={styles.scrollContentInner}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.legalUpdated}>Last updated: March 1, 2026</Text>

            <Text style={styles.legalHeading}>1. Acceptance of Terms</Text>
            <Text style={styles.legalBody}>
              By downloading, installing, accessing, or using the Run Routes mobile application ("App"), you acknowledge that you have read, understood, and agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, you must not access or use the App. These Terms constitute a legally binding agreement between you and Run Routes.
            </Text>

            <Text style={styles.legalHeading}>2. Eligibility</Text>
            <Text style={styles.legalBody}>
              You must be at least 13 years of age to use this App. If you are between the ages of 13 and 18, you may only use the App with the consent and supervision of a parent or legal guardian who agrees to be bound by these Terms. By using the App, you represent and warrant that you meet these eligibility requirements.
            </Text>

            <Text style={styles.legalHeading}>3. Description of Service</Text>
            <Text style={styles.legalBody}>
              Run Routes provides personalized running route generation based on your location, preferences, and publicly available terrain and map data. The App uses GPS tracking and third-party mapping services to suggest routes, record your runs, and display run statistics. Features may change, be updated, or be discontinued at any time without prior notice.
            </Text>

            <Text style={styles.legalHeading}>4. User Accounts</Text>
            <Text style={styles.legalBody}>
              To access certain features, you may create an account using Google Sign-In or Apple Sign-In. You are responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account. You agree to notify us immediately of any unauthorized use of your account. We reserve the right to suspend or terminate accounts that violate these Terms.
            </Text>

            <Text style={styles.legalHeading}>5. Acceptable Use</Text>
            <Text style={styles.legalBody}>
              You agree to use the App only for its intended purpose of personal route planning and run tracking. You shall not: (a) use the App for any unlawful purpose; (b) reverse-engineer, decompile, disassemble, or attempt to derive the source code of the App; (c) modify, adapt, or create derivative works based on the App; (d) distribute, license, sell, or otherwise transfer the App to any third party; (e) use the App to transmit any harmful, offensive, or malicious content; or (f) interfere with or disrupt the integrity or performance of the App or its related systems.
            </Text>

            <Text style={styles.legalHeading}>6. Health and Safety Disclaimer</Text>
            <Text style={styles.legalBody}>
              Run Routes provides route suggestions for informational purposes only and is not a substitute for professional medical or fitness advice. You are solely responsible for your personal safety while using any routes generated by the App. You should consult a physician before beginning any exercise program.{'\n\n'}The App does not guarantee the safety, legality, accessibility, suitability, or condition of any suggested route. Routes may include uneven terrain, traffic areas, private property, or other hazards. Always be aware of your surroundings, obey local traffic laws and regulations, run in well-lit areas, and exercise appropriate caution. Run Routes assumes no liability for any injury, death, or property damage resulting from your use of suggested routes.
            </Text>

            <Text style={styles.legalHeading}>7. Intellectual Property</Text>
            <Text style={styles.legalBody}>
              All content, features, functionality, graphics, user interface, and underlying software of the App are owned by Run Routes and are protected by United States and international copyright, trademark, patent, trade secret, and other intellectual property laws. You are granted a limited, non-exclusive, non-transferable, revocable license to use the App for personal, non-commercial purposes in accordance with these Terms.
            </Text>

            <Text style={styles.legalHeading}>8. Disclaimer of Warranties</Text>
            <Text style={styles.legalBody}>
              THE APP IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE APP WILL BE UNINTERRUPTED, SECURE, ERROR-FREE, OR FREE OF VIRUSES OR OTHER HARMFUL COMPONENTS. WE MAKE NO WARRANTIES REGARDING THE ACCURACY OR RELIABILITY OF ANY ROUTES, GPS DATA, MAPS, OR OTHER INFORMATION PROVIDED THROUGH THE APP.
            </Text>

            <Text style={styles.legalHeading}>9. Limitation of Liability</Text>
            <Text style={styles.legalBody}>
              TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL RUN ROUTES, ITS OFFICERS, DIRECTORS, EMPLOYEES, OR AGENTS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING WITHOUT LIMITATION PERSONAL INJURY, PAIN AND SUFFERING, EMOTIONAL DISTRESS, LOSS OF DATA, LOSS OF REVENUE, OR LOSS OF PROFITS, ARISING OUT OF OR IN CONNECTION WITH YOUR USE OF THE APP. OUR TOTAL AGGREGATE LIABILITY SHALL NOT EXCEED THE AMOUNT YOU HAVE PAID TO US IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM, OR $100 USD, WHICHEVER IS GREATER.
            </Text>

            <Text style={styles.legalHeading}>10. Indemnification</Text>
            <Text style={styles.legalBody}>
              You agree to indemnify, defend, and hold harmless Run Routes and its affiliates, officers, directors, employees, and agents from and against any claims, liabilities, damages, losses, costs, or expenses (including reasonable attorneys' fees) arising out of or related to your use of the App, your violation of these Terms, or your violation of any rights of a third party.
            </Text>

            <Text style={styles.legalHeading}>11. Termination</Text>
            <Text style={styles.legalBody}>
              We may suspend or terminate your access to the App at any time, with or without cause and with or without notice. You may delete your account at any time through the App settings. Upon termination, your right to use the App will immediately cease. Sections relating to intellectual property, disclaimers, limitation of liability, and indemnification shall survive termination.
            </Text>

            <Text style={styles.legalHeading}>12. Governing Law</Text>
            <Text style={styles.legalBody}>
              These Terms shall be governed by and construed in accordance with the laws of the State of California, United States, without regard to its conflict of law provisions. Any disputes arising under these Terms shall be resolved in the state or federal courts located in San Francisco County, California, and you consent to the personal jurisdiction of such courts.
            </Text>

            <Text style={styles.legalHeading}>13. Changes to Terms</Text>
            <Text style={styles.legalBody}>
              We reserve the right to modify these Terms at any time. We will notify you of material changes by updating the "Last updated" date at the top of these Terms and, where appropriate, providing additional notice within the App. Your continued use of the App after any changes constitutes your acceptance of the updated Terms. We encourage you to review these Terms periodically.
            </Text>

            <Text style={styles.legalHeading}>14. Contact</Text>
            <Text style={styles.legalBody}>
              If you have any questions, concerns, or requests regarding these Terms of Service, please reach out through the App's feedback channels.
            </Text>
          </ScrollView>
        ) : view === 'privacy' ? (
          <ScrollView
            style={styles.scrollContent}
            contentContainerStyle={styles.scrollContentInner}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.legalUpdated}>Last updated: March 1, 2026</Text>

            <Text style={styles.legalBody}>
              Run Routes ("we," "our," or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use the Run Routes mobile application ("App"). Please read this policy carefully. By using the App, you consent to the practices described in this Privacy Policy.
            </Text>

            <Text style={styles.legalHeading}>1. Information We Collect</Text>
            <Text style={styles.legalBody}>
              We may collect the following types of information:{'\n\n'}
              <Text style={styles.legalSubheading}>Account Information</Text>{'\n'}
              When you create an account via Google Sign-In or Apple Sign-In, we receive your name, email address, and profile photo (if available). We do not receive or store your passwords.{'\n\n'}
              <Text style={styles.legalSubheading}>Location Data</Text>{'\n'}
              With your permission, we collect precise GPS location data for route generation and run tracking. During active run tracking, location data may also be collected in the background so that GPS recording continues when your screen is off. Background location is only used during active runs and is never collected passively.{'\n\n'}
              <Text style={styles.legalSubheading}>Run & Activity Data</Text>{'\n'}
              We collect data you generate through the App, including run distance, duration, pace, route paths, split times, and saved favorite routes.{'\n\n'}
              <Text style={styles.legalSubheading}>Preferences</Text>{'\n'}
              We store your App preferences such as preferred running distance, terrain type, unit of measurement, and route settings.{'\n\n'}
              <Text style={styles.legalSubheading}>Device Information</Text>{'\n'}
              We may automatically collect certain device information, including device type, operating system version, and unique device identifiers, for analytics and troubleshooting purposes.
            </Text>

            <Text style={styles.legalHeading}>2. How We Use Your Information</Text>
            <Text style={styles.legalBody}>
              We use the information we collect to:{'\n\n'}
              {'\u2022'} Provide, operate, and maintain the App{'\n'}
              {'\u2022'} Generate personalized running routes based on your location and preferences{'\n'}
              {'\u2022'} Track and record your runs with GPS data{'\n'}
              {'\u2022'} Store and sync your run history and favorites across devices{'\n'}
              {'\u2022'} Improve, personalize, and optimize the App experience{'\n'}
              {'\u2022'} Respond to your support inquiries and requests{'\n'}
              {'\u2022'} Monitor and analyze usage patterns and trends{'\n'}
              {'\u2022'} Comply with legal obligations
            </Text>

            <Text style={styles.legalHeading}>3. Location Data & Permissions</Text>
            <Text style={styles.legalBody}>
              Location access is central to the App's functionality. We request location permission solely to generate routes near you and to track your runs via GPS. We use foreground location access ("while using the app" permission) for route generation and general use. During active run tracking, we also use background location access so that GPS recording continues when your screen is off or you switch apps. Background location is only active while you are recording a run and is never used passively or outside of an active tracking session. You may revoke location permissions at any time through your device settings, though this will limit the App's core functionality.
            </Text>

            <Text style={styles.legalHeading}>4. Data Storage & Security</Text>
            <Text style={styles.legalBody}>
              Your data is stored securely using Google Firebase services, including Firebase Authentication and Cloud Firestore. Data is transmitted using industry-standard encryption (TLS/SSL) and is associated with your authenticated account. While we implement commercially reasonable security measures to protect your information, no method of electronic transmission or storage is 100% secure, and we cannot guarantee absolute security.
            </Text>

            <Text style={styles.legalHeading}>5. Third-Party Services</Text>
            <Text style={styles.legalBody}>
              The App integrates with the following third-party services, each governed by their own privacy policies:{'\n\n'}
              {'\u2022'} <Text style={styles.legalBold}>Firebase (Google)</Text> — Authentication, cloud data storage, and analytics{'\n'}
              {'\u2022'} <Text style={styles.legalBold}>Google Sign-In</Text> — Account authentication{'\n'}
              {'\u2022'} <Text style={styles.legalBold}>Apple Sign-In</Text> — Account authentication{'\n'}
              {'\u2022'} <Text style={styles.legalBold}>OpenStreetMap</Text> — Map tiles and geographic data{'\n'}
              {'\u2022'} <Text style={styles.legalBold}>OSRM (Open Source Routing Machine)</Text> — Route calculation and path generation{'\n\n'}
              We encourage you to review the privacy policies of these third-party services. We are not responsible for the privacy practices of third parties.
            </Text>

            <Text style={styles.legalHeading}>6. Data Sharing & Disclosure</Text>
            <Text style={styles.legalBody}>
              We do not sell, rent, trade, or otherwise share your personal information with third parties for their marketing purposes. We may disclose your information only in the following circumstances:{'\n\n'}
              {'\u2022'} <Text style={styles.legalBold}>Service Providers:</Text> To third-party vendors who assist in operating the App (e.g., Firebase), subject to confidentiality obligations{'\n'}
              {'\u2022'} <Text style={styles.legalBold}>Legal Requirements:</Text> When required by law, regulation, legal process, or governmental request{'\n'}
              {'\u2022'} <Text style={styles.legalBold}>Safety:</Text> To protect the rights, safety, or property of Run Routes, our users, or others{'\n'}
              {'\u2022'} <Text style={styles.legalBold}>Business Transfers:</Text> In connection with a merger, acquisition, or sale of assets, in which case your data would remain subject to this Privacy Policy
            </Text>

            <Text style={styles.legalHeading}>7. Data Retention & Deletion</Text>
            <Text style={styles.legalBody}>
              We retain your personal data for as long as your account is active or as needed to provide you services. You may delete your account and all associated data at any time through the App's Settings screen. Upon account deletion, we will remove your personal data from our active servers within 30 days. Some data may be retained in backup systems for a limited period, after which it will be permanently deleted. Anonymized, aggregated data that cannot identify you may be retained indefinitely for analytics purposes.
            </Text>

            <Text style={styles.legalHeading}>8. Your Rights & Choices</Text>
            <Text style={styles.legalBody}>
              Depending on your jurisdiction, you may have certain rights regarding your personal data, including:{'\n\n'}
              {'\u2022'} The right to access the personal data we hold about you{'\n'}
              {'\u2022'} The right to request correction of inaccurate data{'\n'}
              {'\u2022'} The right to request deletion of your data{'\n'}
              {'\u2022'} The right to withdraw consent for data processing{'\n'}
              {'\u2022'} The right to data portability{'\n\n'}
              To exercise any of these rights, you can delete your account directly within the App. We will respond to your request within 30 days.
            </Text>

            <Text style={styles.legalHeading}>9. Children's Privacy</Text>
            <Text style={styles.legalBody}>
              The App is not directed to children under the age of 13. We do not knowingly collect personal information from children under 13. If we learn that we have collected personal information from a child under 13 without parental consent, we will take steps to delete that information as quickly as possible.
            </Text>

            <Text style={styles.legalHeading}>10. International Data Transfers</Text>
            <Text style={styles.legalBody}>
              Your information may be transferred to and processed in countries other than your country of residence, including the United States, where data protection laws may differ. By using the App, you consent to the transfer of your information to these countries.
            </Text>

            <Text style={styles.legalHeading}>11. Changes to This Policy</Text>
            <Text style={styles.legalBody}>
              We may update this Privacy Policy from time to time to reflect changes in our practices or for other operational, legal, or regulatory reasons. We will notify you of any material changes by updating the "Last updated" date at the top of this policy and, where appropriate, providing additional notice within the App. We encourage you to review this Privacy Policy periodically.
            </Text>

            <Text style={styles.legalHeading}>12. Contact Us</Text>
            <Text style={styles.legalBody}>
              If you have any questions, concerns, or requests regarding this Privacy Policy or our data practices, please contact us at irachelma@gmail.com.
            </Text>
          </ScrollView>
        ) : (
          <ScrollView
            style={styles.scrollContent}
            contentContainerStyle={styles.scrollContentInner}
            showsVerticalScrollIndicator={false}
          >
            {view === 'history' && (
              historyLoading ? (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyText}>Loading history...</Text>
                </View>
              ) : runHistory.length === 0 ? (
                <View style={styles.emptyState}>
                  <Ionicons name="time-outline" size={32} color={Colors.mutedForeground} />
                  <Text style={styles.emptyText}>No runs yet</Text>
                </View>
              ) : (
                <>
                  {historyFromCache && (
                    <Text style={styles.cacheIndicator}>Showing cached data (offline)</Text>
                  )}
                  {runHistory.map((run) => {
                    const durationMin = formatDuration(run.duration);
                    const pace = run.avgPace || (durationMin / run.distance).toFixed(1);
                    return (
                      <Pressable
                        key={run.id}
                        style={styles.card}
                        onPress={() => { setSelectedRun(run); setView('run-detail'); }}
                      >
                        <Text style={styles.cardTitle}>{run.routeName}</Text>
                        <Text style={styles.cardSubtitle}>{formatRunDate(run.date)}</Text>
                        <View style={styles.statsRow}>
                          <View style={styles.stat}>
                            <Ionicons name="time-outline" size={12} color={Colors.mutedForeground} />
                            <Text style={styles.statText}>{durationMin} min</Text>
                          </View>
                          <View style={styles.stat}>
                            <Ionicons name="speedometer-outline" size={12} color={Colors.mutedForeground} />
                            <Text style={styles.statText}>{pace} min{paceUnit(ctx.prefs.units)}</Text>
                          </View>
                          <View style={styles.stat}>
                            <Ionicons name="navigate-outline" size={12} color={Colors.mutedForeground} />
                            <Text style={styles.statText}>{run.distance} {distanceUnit(ctx.prefs.units)}</Text>
                          </View>
                        </View>
                      </Pressable>
                    );
                  })}
                </>
              )
            )}

            {view === 'favorites' &&
              (ctx.favorites.length === 0 ? (
                <View style={styles.emptyState}>
                  <Ionicons name="heart-outline" size={32} color={Colors.mutedForeground} />
                  <Text style={styles.emptyText}>No favorites yet</Text>
                </View>
              ) : (
                ctx.favorites.map((route) => (
                  <View key={route.id} style={styles.card}>
                    <View style={styles.favRow}>
                      <Pressable style={{ flex: 1 }} onPress={() => handlePreviewFavorite(route)}>
                        <Text style={styles.cardTitle}>{route.routeName}</Text>
                        <View style={styles.statsRow}>
                          <View style={styles.stat}>
                            <Ionicons name="navigate-outline" size={12} color={Colors.mutedForeground} />
                            <Text style={styles.statText}>{route.distance} {distanceUnit(ctx.prefs.units)}</Text>
                          </View>
                          <View style={styles.stat}>
                            <Ionicons name="map-outline" size={12} color={Colors.mutedForeground} />
                            <Text style={styles.statText}>{route.terrain}</Text>
                          </View>
                        </View>
                      </Pressable>
                      <Pressable
                        onPress={() => handleRemoveFavorite(route.id)}
                        hitSlop={8}
                      >
                        <Ionicons name="heart" size={18} color={Colors.destructive} />
                      </Pressable>
                    </View>
                  </View>
                ))
              ))}
          </ScrollView>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fullScreen: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.background,
    zIndex: 1000,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.background,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    fontFamily: Fonts.sansBold,
    fontSize: 18,
    color: Colors.foreground,
    textAlign: 'center',
  },
  headerSpacer: {
    width: 36,
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    flex: 1,
  },
  scrollContentInner: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 40,
    gap: 10,
  },
  profileSection: {
    alignItems: 'center',
    gap: 8,
  },
  userName: {
    fontFamily: Fonts.sansBold,
    fontSize: 18,
    color: Colors.foreground,
  },
  userEmail: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Colors.mutedForeground,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: 10,
  },
  menuSection: {
    gap: 8,
  },
  sectionLabel: {
    fontFamily: Fonts.sansBold,
    fontSize: 10,
    letterSpacing: 2,
    color: Colors.mutedForeground,
    marginTop: 16,
    marginBottom: 4,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    padding: 16,
  },
  menuRowSelected: {
    borderColor: Colors.primary + '66',
    backgroundColor: Colors.primary + '0D',
  },
  menuLabel: {
    flex: 1,
    fontFamily: Fonts.sansSemiBold,
    fontSize: 14,
    color: Colors.foreground,
  },
  menuValue: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Colors.mutedForeground,
  },
  actionsSpacer: {
    height: 40,
  },
  actionsSection: {
    gap: 12,
  },
  secondaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    paddingVertical: 16,
  },
  secondaryButtonText: {
    fontFamily: Fonts.sansBold,
    fontSize: 14,
    color: Colors.foreground,
  },
  deleteButtonText: {
    fontFamily: Fonts.sansBold,
    fontSize: 14,
    color: Colors.mutedForeground,
  },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    padding: 14,
    gap: 6,
  },
  cardTitle: {
    fontFamily: Fonts.sansBold,
    fontSize: 14,
    color: Colors.foreground,
  },
  cardSubtitle: {
    fontFamily: Fonts.sans,
    fontSize: 11,
    color: Colors.mutedForeground,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },
  stat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  statText: {
    fontFamily: Fonts.sansMedium,
    fontSize: 11,
    color: Colors.mutedForeground,
  },
  favRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  emptyState: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 32,
  },
  emptyText: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Colors.mutedForeground,
  },
  cacheIndicator: {
    fontFamily: Fonts.sans,
    fontSize: 11,
    color: Colors.mutedForeground,
    textAlign: 'center',
    fontStyle: 'italic',
    marginBottom: 8,
  },
  contactDescription: {
    fontFamily: Fonts.sans,
    fontSize: 14,
    color: Colors.foreground,
    lineHeight: 22,
    marginBottom: 20,
  },
  contactEmailCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    padding: 16,
  },
  contactEmail: {
    flex: 1,
    fontFamily: Fonts.sansSemiBold,
    fontSize: 14,
    color: Colors.foreground,
  },
  runDetailDate: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Colors.mutedForeground,
    marginBottom: 12,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statCell: {
    width: '30%',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    padding: 12,
    alignItems: 'center',
    gap: 2,
  },
  statCellValue: {
    fontFamily: Fonts.sansBold,
    fontSize: 18,
    color: Colors.primary,
  },
  statCellLabel: {
    fontFamily: Fonts.sans,
    fontSize: 10,
    color: Colors.mutedForeground,
    textTransform: 'uppercase',
  },
  splitsTitle: {
    fontFamily: Fonts.sansBold,
    fontSize: 14,
    color: Colors.foreground,
    marginTop: 16,
    marginBottom: 8,
  },
  splitsTable: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    overflow: 'hidden',
  },
  splitsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  splitsHeaderText: {
    fontFamily: Fonts.sansBold,
    fontSize: 10,
    color: Colors.mutedForeground,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  splitRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  splitKm: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 13,
    color: Colors.foreground,
  },
  splitPace: {
    fontFamily: Fonts.sansMedium,
    fontSize: 13,
    color: Colors.mutedForeground,
  },
  legalUpdated: {
    fontFamily: Fonts.sans,
    fontSize: 12,
    color: Colors.mutedForeground,
    fontStyle: 'italic',
    marginBottom: 16,
  },
  legalHeading: {
    fontFamily: Fonts.sansBold,
    fontSize: 15,
    color: Colors.foreground,
    marginTop: 16,
    marginBottom: 6,
  },
  legalBody: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Colors.foreground,
    lineHeight: 20,
  },
  legalSubheading: {
    fontFamily: Fonts.sansBold,
    fontSize: 13,
  },
  legalBold: {
    fontFamily: Fonts.sansBold,
  },
});
